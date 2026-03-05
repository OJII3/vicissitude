import { existsSync } from "fs";
import { resolve } from "path";

import { HandleHomeChannelMessageUseCase } from "./application/use-cases/handle-home-channel-message.use-case.ts";
import { HandleIncomingMessageUseCase } from "./application/use-cases/handle-incoming-message.use-case.ts";
import type { BootstrapContext } from "./bootstrap-context.ts";
import { createHeartbeat, setupShutdown, startSessionGauge } from "./bootstrap-helpers.ts";
import type { AiAgent } from "./domain/ports/ai-agent.port.ts";
import type { Logger } from "./domain/ports/logger.port.ts";
import { CooldownTracker } from "./domain/services/cooldown-tracker.ts";
import { MessageBatcher } from "./domain/services/message-batcher.ts";
import { FileContextLoaderFactory } from "./infrastructure/context/file-context-loader-factory.ts";
import { JsonChannelConfigLoader } from "./infrastructure/context/json-channel-config-loader.ts";
import { DiscordConversationHistory } from "./infrastructure/discord/discord-conversation-history.ts";
import { DiscordEmojiProvider } from "./infrastructure/discord/discord-emoji-provider.ts";
import { DiscordGateway } from "./infrastructure/discord/discord-gateway.ts";
import { ConsoleLogger } from "./infrastructure/logging/console-logger.ts";
import { InstrumentedAiAgent } from "./infrastructure/metrics/instrumented-ai-agent.ts";
import { InstrumentedResponseJudge } from "./infrastructure/metrics/instrumented-response-judge.ts";
import { METRIC } from "./infrastructure/metrics/metric-names.ts";
import { PrometheusCollector } from "./infrastructure/metrics/prometheus-collector.ts";
import { PrometheusServer } from "./infrastructure/metrics/prometheus-server.ts";
import { bootstrapCopilot } from "./infrastructure/opencode/bootstrap-copilot.ts";
import { OpencodeAgent } from "./infrastructure/opencode/opencode-agent.ts";
import { OpencodeJudgeAgent } from "./infrastructure/opencode/opencode-judge-agent.ts";
import { OpencodeResponseJudge } from "./infrastructure/opencode/opencode-response-judge.ts";
import { JsonEmojiUsageRepository } from "./infrastructure/persistence/json-emoji-usage-repository.ts";
import { JsonSessionRepository } from "./infrastructure/persistence/json-session-repository.ts";

async function loadChannelConfig(root: string) {
	const overlayChannels = resolve(root, "data/context/channels.json");
	const baseChannels = resolve(root, "context/channels.json");
	const channelsJson = existsSync(overlayChannels)
		? await Bun.file(overlayChannels).json()
		: await Bun.file(baseChannels).json();
	return new JsonChannelConfigLoader(channelsJson);
}

function createMetrics(logger: Logger) {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.DISCORD_MESSAGES_RECEIVED, "Discord messages received");
	collector.registerCounter(METRIC.AI_REQUESTS, "AI agent requests");
	collector.registerCounter(METRIC.JUDGE_REQUESTS, "Response judge requests");
	collector.registerCounter(METRIC.HEARTBEAT_TICKS, "Heartbeat scheduler ticks");
	collector.registerCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED, "Heartbeat reminders executed");
	collector.registerGauge(METRIC.BOT_INFO, "Bot information");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "AI request duration in seconds");
	collector.registerHistogram(METRIC.HEARTBEAT_TICK_DURATION, "Heartbeat tick duration in seconds");
	collector.registerGauge(METRIC.LLM_ACTIVE_SESSIONS, "Registered LLM sessions");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "LLM sessions currently processing");
	collector.setGauge(METRIC.BOT_INFO, 1, { bot_name: "fua" });
	return { collector, server: new PrometheusServer(collector, logger) };
}

export async function bootstrap(): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	if (!token) throw new Error("DISCORD_TOKEN is required in .env");

	const root = resolve(import.meta.dirname, "..");
	const logger = new ConsoleLogger();
	const sessions = new JsonSessionRepository(resolve(root, "data"));
	const contextLoaderFactory = new FileContextLoaderFactory(
		resolve(root, "data/context"),
		resolve(root, "context"),
	);
	const gateway = new DiscordGateway(token, logger);
	const { collector: metrics, server: metricsServer } = createMetrics(logger);
	metricsServer.start();

	const channelConfig = await loadChannelConfig(root);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	const ctx: BootstrapContext = {
		root,
		sessions,
		contextLoaderFactory,
		gateway,
		channelConfig,
		logger,
		metrics,
		metricsServer,
	};
	const providerID = process.env.OPENCODE_PROVIDER_ID ?? "opencode";
	if (providerID === "github-copilot") {
		await bootstrapCopilot(ctx);
	} else {
		await bootstrapDefault(ctx);
	}
}

function createDefaultUseCases(ctx: BootstrapContext, agent: AiAgent) {
	const { root, gateway, channelConfig, logger, metrics } = ctx;
	const judgeAgent = new OpencodeJudgeAgent();
	const rawJudge = new OpencodeResponseJudge(judgeAgent, logger);
	const responseJudge = new InstrumentedResponseJudge(rawJudge, metrics);
	const conversationHistory = new DiscordConversationHistory(() => gateway.getClient());
	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(root, "data"));
	const handleMessage = new HandleIncomingMessageUseCase(
		agent,
		logger,
		responseJudge,
		conversationHistory,
	);
	const handleHomeMessage = new HandleHomeChannelMessageUseCase(
		agent,
		responseJudge,
		conversationHistory,
		channelConfig,
		new CooldownTracker(),
		new DiscordEmojiProvider(() => gateway.getClient()),
		emojiUsageRepo,
		logger,
		new MessageBatcher(),
	);
	return { judgeAgent, handleMessage, handleHomeMessage, emojiUsageRepo };
}

async function bootstrapDefault(ctx: BootstrapContext) {
	const { root, gateway, logger, metrics, metricsServer } = ctx;
	const rawAgent = new OpencodeAgent(ctx.sessions, ctx.contextLoaderFactory, logger);
	const agent = new InstrumentedAiAgent(rawAgent, metrics, "opencode");
	const { judgeAgent, handleMessage, handleHomeMessage, emojiUsageRepo } = createDefaultUseCases(
		ctx,
		agent,
	);

	gateway.onHomeChannelMessage(async (msg, ch) => {
		metrics.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "home" });
		await handleHomeMessage.execute(msg, ch);
	});
	gateway.onMessage(async (msg, ch) => {
		metrics.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "mention" });
		await handleMessage.execute(msg, ch);
	});
	gateway.onEmojiUsed((guildId, emojiName) => emojiUsageRepo.increment(guildId, emojiName));

	const scheduler = createHeartbeat(root, agent, logger, metrics);
	const sessionGaugeTimer = startSessionGauge(ctx.sessions, metrics);
	setupShutdown(
		logger,
		scheduler,
		gateway,
		rawAgent,
		emojiUsageRepo,
		judgeAgent,
		metricsServer,
		sessionGaugeTimer,
	);
	await gateway.start();
	scheduler.start();
}
