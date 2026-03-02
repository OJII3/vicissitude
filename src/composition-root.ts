import { existsSync } from "fs";
import { resolve } from "path";

import { BufferEventUseCase } from "./application/use-cases/buffer-event.use-case.ts";
import { HandleHeartbeatUseCase } from "./application/use-cases/handle-heartbeat.use-case.ts";
import { HandleHomeChannelMessageUseCase } from "./application/use-cases/handle-home-channel-message.use-case.ts";
import { HandleIncomingMessageUseCase } from "./application/use-cases/handle-incoming-message.use-case.ts";
import type { AiAgent } from "./domain/ports/ai-agent.port.ts";
import type { Logger } from "./domain/ports/logger.port.ts";
import type { IncomingMessage } from "./domain/ports/message-gateway.port.ts";
import { CooldownTracker } from "./domain/services/cooldown-tracker.ts";
import { MessageBatcher } from "./domain/services/message-batcher.ts";
import { FileContextLoaderFactory } from "./infrastructure/context/file-context-loader-factory.ts";
import { JsonChannelConfigLoader } from "./infrastructure/context/json-channel-config-loader.ts";
import { DiscordConversationHistory } from "./infrastructure/discord/discord-conversation-history.ts";
import { DiscordEmojiProvider } from "./infrastructure/discord/discord-emoji-provider.ts";
import { DiscordGateway } from "./infrastructure/discord/discord-gateway.ts";
import { ConsoleLogger } from "./infrastructure/logging/console-logger.ts";
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
	const logger = new ConsoleLogger();
	const sessions = new JsonSessionRepository(resolve(root, "data"));
	const contextLoaderFactory = new FileContextLoaderFactory(
		resolve(root, "data/context"),
		resolve(root, "context"),
	);
	const gateway = new DiscordGateway(token, logger);

	// Channel config (overlay → base fallback)
	const channelConfig = await loadChannelConfig(root);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	const providerID = process.env.OPENCODE_PROVIDER_ID ?? "opencode";
	const isCopilot = providerID === "github-copilot";

	if (isCopilot) {
		await bootstrapCopilot(root, sessions, contextLoaderFactory, gateway, channelConfig, logger);
	} else {
		await bootstrapDefault(root, sessions, contextLoaderFactory, gateway, channelConfig, logger);
	}
}

function createGuildAgents(
	root: string,
	guildIds: string[],
	sessions: JsonSessionRepository,
	contextLoaderFactory: FileContextLoaderFactory,
	logger: Logger,
) {
	const agents = new Map<string, CopilotPollingAgent>();
	const bufferUseCases = new Map<string, BufferEventUseCase>();

	for (const guildId of guildIds) {
		const bufferDir = resolve(root, `data/event-buffer/guilds/${guildId}`);
		const eventBuffer = new FileEventBuffer(bufferDir);
		const agent = new CopilotPollingAgent(
			guildId,
			sessions,
			contextLoaderFactory,
			eventBuffer,
			logger,
		);
		agents.set(guildId, agent);
		bufferUseCases.set(guildId, new BufferEventUseCase(eventBuffer, logger));
	}

	return { agents, bufferUseCases };
}

async function bootstrapCopilot(
	root: string,
	sessions: JsonSessionRepository,
	contextLoaderFactory: FileContextLoaderFactory,
	gateway: DiscordGateway,
	channelConfig: JsonChannelConfigLoader,
	logger: Logger,
) {
	const guildIds = channelConfig.getGuildIds();
	const { agents, bufferUseCases } = createGuildAgents(
		root,
		guildIds,
		sessions,
		contextLoaderFactory,
		logger,
	);

	// メッセージハンドラ: guildId に基づきギルド別バッファに振り分け
	const routeMessage = async (msg: IncomingMessage) => {
		const useCase = msg.guildId ? bufferUseCases.get(msg.guildId) : undefined;
		if (useCase) {
			await useCase.execute(msg);
		} else {
			logger.warn(`[bootstrap] No buffer for guildId=${msg.guildId}, dropping event`);
		}
	};
	gateway.onMessage((msg) => routeMessage(msg));
	gateway.onHomeChannelMessage((msg) => routeMessage(msg));

	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(root, "data"));
	gateway.onEmojiUsed((guildId, emojiName) => emojiUsageRepo.increment(guildId, emojiName));

	const routingAgent = new GuildRoutingAgent(agents);
	const { scheduler: heartbeatScheduler } = createHeartbeat(root, routingAgent, logger);
	setupShutdown(logger, heartbeatScheduler, gateway, routingAgent, emojiUsageRepo);

	logger.info(
		`[bootstrap] Copilot polling mode enabled for ${guildIds.length} guild(s): ${guildIds.join(", ")}`,
	);
	await gateway.start();
	heartbeatScheduler.start();
	await Promise.all([...agents.values()].map((agent) => agent.startPollingLoop()));
}

async function bootstrapDefault(
	root: string,
	sessions: JsonSessionRepository,
	contextLoaderFactory: FileContextLoaderFactory,
	gateway: DiscordGateway,
	channelConfig: JsonChannelConfigLoader,
	logger: Logger,
) {
	const agent = new OpencodeAgent(sessions, contextLoaderFactory, logger);
	const judgeAgent = new OpencodeJudgeAgent();

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
	setupShutdown(logger, heartbeatScheduler, gateway, agent, emojiUsageRepo, judgeAgent);

	await gateway.start();
	heartbeatScheduler.start();
}

function setupShutdown(
	logger: Logger,
	scheduler: IntervalHeartbeatScheduler,
	gateway: DiscordGateway,
	agent: AiAgent,
	emojiUsageRepo: JsonEmojiUsageRepository,
	judgeAgent?: AiAgent,
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
		void emojiUsageRepo.flush().finally(() => {
			setTimeout(() => process.exit(0), 1000);
		});
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
