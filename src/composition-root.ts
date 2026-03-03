import { existsSync } from "fs";
import { resolve } from "path";

import { BufferEventUseCase } from "./application/use-cases/buffer-event.use-case.ts";
import { HandleHeartbeatUseCase } from "./application/use-cases/handle-heartbeat.use-case.ts";
import { HandleHomeChannelMessageUseCase } from "./application/use-cases/handle-home-channel-message.use-case.ts";
import { HandleIncomingMessageUseCase } from "./application/use-cases/handle-incoming-message.use-case.ts";
import type { AiAgent } from "./domain/ports/ai-agent.port.ts";
import type { Logger } from "./domain/ports/logger.port.ts";
import type { IncomingMessage } from "./domain/ports/message-gateway.port.ts";
import type { MetricsCollector } from "./domain/ports/metrics-collector.port.ts";
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
import { CopilotPollingAgent } from "./infrastructure/opencode/copilot-polling-agent.ts";
import { GuildRoutingAgent } from "./infrastructure/opencode/guild-routing-agent.ts";
import { OpencodeAgent } from "./infrastructure/opencode/opencode-agent.ts";
import { OpencodeJudgeAgent } from "./infrastructure/opencode/opencode-judge-agent.ts";
import { OpencodeResponseJudge } from "./infrastructure/opencode/opencode-response-judge.ts";
import { FileEventBuffer } from "./infrastructure/persistence/file-event-buffer.ts";
import { JsonEmojiUsageRepository } from "./infrastructure/persistence/json-emoji-usage-repository.ts";
import { JsonHeartbeatConfigRepository } from "./infrastructure/persistence/json-heartbeat-config-repository.ts";
import { JsonSessionRepository } from "./infrastructure/persistence/json-session-repository.ts";
import { IntervalHeartbeatScheduler } from "./infrastructure/scheduler/interval-heartbeat-scheduler.ts";

interface BootstrapContext {
	root: string;
	sessions: JsonSessionRepository;
	contextLoaderFactory: FileContextLoaderFactory;
	gateway: DiscordGateway;
	channelConfig: JsonChannelConfigLoader;
	logger: Logger;
	metrics: PrometheusCollector;
	metricsServer: PrometheusServer;
}

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
	collector.setGauge(METRIC.BOT_INFO, 1, { bot_name: "fua" });
	return { collector, server: new PrometheusServer(collector, logger) };
}

function createHeartbeat(root: string, agent: AiAgent, logger: Logger, metrics?: MetricsCollector) {
	const configRepo = new JsonHeartbeatConfigRepository(resolve(root, "data/heartbeat-config.json"));
	const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);
	return new IntervalHeartbeatScheduler(configRepo, useCase, logger, metrics);
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

// bootstrapDefault パスの OpencodeAgent(4096) / OpencodeJudgeAgent(4097) と
// 範囲が重複するが、bootstrapCopilot と bootstrapDefault は排他的に実行される
const COPILOT_BASE_PORT = 4096;

function createGuildAgents(ctx: BootstrapContext, guildIds: string[]) {
	const agents = new Map<string, CopilotPollingAgent>();
	const bufferUseCases = new Map<string, BufferEventUseCase>();
	for (const [index, guildId] of guildIds.entries()) {
		const bufferDir = resolve(ctx.root, `data/event-buffer/guilds/${guildId}`);
		const eventBuffer = new FileEventBuffer(bufferDir);
		const port = COPILOT_BASE_PORT + index;
		const agent = new CopilotPollingAgent(
			guildId,
			ctx.sessions,
			ctx.contextLoaderFactory,
			eventBuffer,
			ctx.logger,
			port,
		);
		agents.set(guildId, agent);
		bufferUseCases.set(guildId, new BufferEventUseCase(eventBuffer, ctx.logger));
	}
	return { agents, bufferUseCases };
}

async function bootstrapCopilot(ctx: BootstrapContext) {
	const { gateway, channelConfig, logger, metrics, metricsServer } = ctx;
	const guildIds = channelConfig.getGuildIds();
	const { agents, bufferUseCases } = createGuildAgents(ctx, guildIds);

	const routeBuffer = async (msg: IncomingMessage) => {
		const useCase = msg.guildId ? bufferUseCases.get(msg.guildId) : undefined;
		if (useCase) {
			await useCase.execute(msg);
		} else {
			logger.warn(`[bootstrap] No buffer for guildId=${msg.guildId}, dropping event`);
		}
	};
	gateway.onHomeChannelMessage(async (msg) => {
		metrics.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "home" });
		await routeBuffer(msg);
	});
	gateway.onMessage(async (msg) => {
		metrics.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "mention" });
		await routeBuffer(msg);
	});

	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(ctx.root, "data"));
	gateway.onEmojiUsed((guildId, emojiName) => emojiUsageRepo.increment(guildId, emojiName));

	const firstAgent = agents.values().next().value as CopilotPollingAgent | undefined;
	if (!firstAgent) {
		throw new Error("No guild agents available; cannot create defaultAgent for GuildRoutingAgent");
	}
	const routingAgent = new InstrumentedAiAgent(new GuildRoutingAgent(agents, firstAgent), metrics);
	const scheduler = createHeartbeat(ctx.root, routingAgent, logger, metrics);
	setupShutdown(logger, scheduler, gateway, routingAgent, emojiUsageRepo, undefined, metricsServer);

	logger.info(
		`[bootstrap] Copilot polling mode for ${guildIds.length} guild(s): ${guildIds.join(", ")}`,
	);
	await gateway.start();
	scheduler.start();
	for (const [guildId, agent] of agents) {
		agent.startPollingLoop().catch((err) => {
			logger.error(`[bootstrap] polling loop for guild ${guildId} unexpectedly rejected`, err);
		});
	}
}

async function bootstrapDefault(ctx: BootstrapContext) {
	const { root, gateway, channelConfig, logger, metrics, metricsServer } = ctx;
	const rawAgent = new OpencodeAgent(ctx.sessions, ctx.contextLoaderFactory, logger);
	const agent = new InstrumentedAiAgent(rawAgent, metrics);
	const judgeAgent = new OpencodeJudgeAgent();
	const rawJudge = new OpencodeResponseJudge(judgeAgent, logger);
	const responseJudge = new InstrumentedResponseJudge(rawJudge, metrics);

	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(root, "data"));
	const handleMessage = new HandleIncomingMessageUseCase(agent, logger);
	const handleHomeMessage = new HandleHomeChannelMessageUseCase(
		agent,
		responseJudge,
		new DiscordConversationHistory(() => gateway.getClient()),
		channelConfig,
		new CooldownTracker(),
		new DiscordEmojiProvider(() => gateway.getClient()),
		emojiUsageRepo,
		logger,
		new MessageBatcher(),
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
	setupShutdown(logger, scheduler, gateway, rawAgent, emojiUsageRepo, judgeAgent, metricsServer);
	await gateway.start();
	scheduler.start();
}

function setupShutdown(
	logger: Logger,
	scheduler: IntervalHeartbeatScheduler,
	gateway: DiscordGateway,
	agent: AiAgent,
	emojiUsageRepo: JsonEmojiUsageRepository,
	judgeAgent?: AiAgent,
	metricsServer?: PrometheusServer,
) {
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down...");
		scheduler.stop();
		gateway.stop();
		agent.stop();
		judgeAgent?.stop();
		metricsServer?.stop();
		void emojiUsageRepo.flush().finally(() => setTimeout(() => process.exit(0), 1000));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
