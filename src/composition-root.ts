import { existsSync } from "fs";
import { resolve } from "path";

import { HandleHeartbeatUseCase } from "./application/use-cases/handle-heartbeat.use-case.ts";
import { HandleHomeChannelMessageUseCase } from "./application/use-cases/handle-home-channel-message.use-case.ts";
import { HandleIncomingMessageUseCase } from "./application/use-cases/handle-incoming-message.use-case.ts";
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
import { OpencodeAgent } from "./infrastructure/opencode/opencode-agent.ts";
import { OpencodeJudgeAgent } from "./infrastructure/opencode/opencode-judge-agent.ts";
import { OpencodeResponseJudge } from "./infrastructure/opencode/opencode-response-judge.ts";
import { JsonEmojiUsageRepository } from "./infrastructure/persistence/json-emoji-usage-repository.ts";
import { JsonHeartbeatConfigRepository } from "./infrastructure/persistence/json-heartbeat-config-repository.ts";
import { JsonSessionRepository } from "./infrastructure/persistence/json-session-repository.ts";
import { IntervalHeartbeatScheduler } from "./infrastructure/scheduler/interval-heartbeat-scheduler.ts";

function createInfrastructure(root: string, token: string) {
	const logger = new ConsoleLogger();
	const sessions = new JsonSessionRepository(resolve(root, "data"));
	const contextLoaderFactory = new FileContextLoaderFactory(
		resolve(root, "data/context"),
		resolve(root, "context"),
	);
	const agent = new OpencodeAgent(sessions, contextLoaderFactory, logger);
	const judgeAgent = new OpencodeJudgeAgent();
	const gateway = new DiscordGateway(token, logger);
	return { logger, agent, judgeAgent, gateway };
}

async function loadChannelConfig(root: string) {
	const overlayChannels = resolve(root, "data/context/channels.json");
	const baseChannels = resolve(root, "context/channels.json");
	const channelsJson = existsSync(overlayChannels)
		? await Bun.file(overlayChannels).json()
		: await Bun.file(baseChannels).json();
	return new JsonChannelConfigLoader(channelsJson);
}

function createHeartbeat(root: string, agent: AiAgent, logger: Logger) {
	const configRepo = new JsonHeartbeatConfigRepository(resolve(root, "data/heartbeat-config.json"));
	const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);
	const scheduler = new IntervalHeartbeatScheduler(configRepo, useCase, logger);
	return { scheduler };
}

export async function bootstrap(): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	if (!token) throw new Error("DISCORD_TOKEN is required in .env");

	const root = resolve(import.meta.dirname, "..");
	const { logger, agent, judgeAgent, gateway } = createInfrastructure(root, token);

	// Channel config (overlay → base fallback)
	const channelConfig = await loadChannelConfig(root);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	// Home channel infrastructure
	const conversationHistory = new DiscordConversationHistory(() => gateway.getClient());
	const emojiProvider = new DiscordEmojiProvider(() => gateway.getClient());
	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(root, "data"));
	const responseJudge = new OpencodeResponseJudge(judgeAgent, logger);
	const cooldown = new CooldownTracker();
	const messageBatcher = new MessageBatcher();

	// Heartbeat
	const { scheduler: heartbeatScheduler } = createHeartbeat(root, agent, logger);

	// Use cases
	const handleMessage = new HandleIncomingMessageUseCase(agent, logger);
	const handleHomeMessage = new HandleHomeChannelMessageUseCase(
		agent,
		responseJudge,
		conversationHistory,
		channelConfig,
		cooldown,
		emojiProvider,
		emojiUsageRepo,
		logger,
		messageBatcher,
	);

	// Wiring
	gateway.onMessage((msg, ch) => handleMessage.execute(msg, ch));
	gateway.onHomeChannelMessage((msg, ch) => handleHomeMessage.execute(msg, ch));
	gateway.onEmojiUsed((guildId, emojiName) => {
		emojiUsageRepo.increment(guildId, emojiName);
	});

	// Graceful shutdown
	setupShutdown(logger, heartbeatScheduler, gateway, agent, judgeAgent, emojiUsageRepo);

	await gateway.start();
	heartbeatScheduler.start();
}

function setupShutdown(
	logger: Logger,
	scheduler: IntervalHeartbeatScheduler,
	gateway: DiscordGateway,
	agent: AiAgent,
	judgeAgent: AiAgent,
	emojiUsageRepo: JsonEmojiUsageRepository,
) {
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down...");
		scheduler.stop();
		gateway.stop();
		agent.stop();
		judgeAgent.stop();
		void emojiUsageRepo.flush().finally(() => {
			setTimeout(() => process.exit(0), 1000);
		});
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
