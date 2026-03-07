/* oxlint-disable max-dependencies -- bootstrap file naturally requires many imports for DI wiring */
import { resolve } from "path";

import { BufferEventUseCase } from "../../application/use-cases/buffer-event.use-case.ts";
import { RecordConversationUseCase } from "../../application/use-cases/record-conversation.use-case.ts";
import type { BootstrapContext } from "../../bootstrap-context.ts";
import { createHeartbeat, setupShutdown, startSessionGauge } from "../../bootstrap-helpers.ts";
import type { IncomingMessage } from "../../domain/ports/message-gateway.port.ts";
import { CompositeLLMAdapter } from "../fenghuang/composite-llm-adapter.ts";
import { FenghuangChatAdapter } from "../fenghuang/fenghuang-chat-adapter.ts";
import { FenghuangConversationRecorder } from "../fenghuang/fenghuang-conversation-recorder.ts";
import { InstrumentedAiAgent } from "../metrics/instrumented-ai-agent.ts";
import { METRIC } from "../metrics/metric-names.ts";
import { OllamaEmbeddingAdapter } from "../ollama/ollama-embedding-adapter.ts";
import { FileEventBuffer } from "../persistence/file-event-buffer.ts";
import { JsonEmojiUsageRepository } from "../persistence/json-emoji-usage-repository.ts";
import { GuildRoutingAgent } from "./guild-routing-agent.ts";
import { BASE_PORT } from "./mcp-config.ts";
import { PollingAgent } from "./polling-agent.ts";

function createGuildAgents(ctx: BootstrapContext, guildIds: string[]) {
	const providerId = process.env.OPENCODE_PROVIDER_ID ?? "github-copilot";
	const modelId = process.env.OPENCODE_MODEL_ID ?? "big-pickle";
	const agents = new Map<string, PollingAgent>();
	const bufferUseCases = new Map<string, BufferEventUseCase>();
	for (const [index, guildId] of guildIds.entries()) {
		const bufferDir = resolve(ctx.root, `data/event-buffer/guilds/${guildId}`);
		const eventBuffer = new FileEventBuffer(bufferDir);
		const port = BASE_PORT + index;
		const agent = new PollingAgent(
			guildId,
			ctx.sessions,
			ctx.contextLoaderFactory,
			eventBuffer,
			ctx.logger,
			port,
			providerId,
			modelId,
		);
		agents.set(guildId, agent);
		bufferUseCases.set(guildId, new BufferEventUseCase(eventBuffer, ctx.logger));
	}
	return { agents, bufferUseCases };
}

function setupEventHandlers(
	ctx: BootstrapContext,
	bufferUseCases: Map<string, BufferEventUseCase>,
) {
	const { gateway, logger, metrics } = ctx;
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
}

interface LtmResources {
	chatAdapter: FenghuangChatAdapter;
	recorder: FenghuangConversationRecorder;
}

async function setupLtmRecording(ctx: BootstrapContext): Promise<LtmResources | undefined> {
	const { gateway, logger } = ctx;
	const ltmPort = BASE_PORT - 2;
	const providerId =
		process.env.LTM_PROVIDER_ID ?? process.env.OPENCODE_PROVIDER_ID ?? "github-copilot";
	const modelId = process.env.LTM_MODEL_ID ?? "gpt-4o";
	const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
	const embeddingModel = process.env.LTM_EMBEDDING_MODEL ?? "embeddinggemma";
	const dataDir = resolve(ctx.root, "data/fenghuang");

	try {
		const chatAdapter = new FenghuangChatAdapter(ltmPort, providerId, modelId);
		await chatAdapter.initialize();

		const ollama = new OllamaEmbeddingAdapter(ollamaBaseUrl, embeddingModel);
		const llm = new CompositeLLMAdapter(chatAdapter, ollama);
		const recorder = new FenghuangConversationRecorder(llm, dataDir);
		const useCase = new RecordConversationUseCase(recorder, logger);

		gateway.onAnyMessage(async (msg) => {
			try {
				await useCase.execute(msg);
			} catch (err) {
				logger.error("[ltm-record] failed to record message", err);
			}
		});

		logger.info(`[bootstrap] LTM auto-recording enabled (port=${ltmPort})`);
		return { chatAdapter, recorder };
	} catch (err) {
		logger.error("[bootstrap] LTM auto-recording init failed, continuing without LTM", err);
		return undefined;
	}
}

export async function bootstrapAgents(ctx: BootstrapContext): Promise<void> {
	const { gateway, channelConfig, logger, metrics, metricsServer, sessions } = ctx;
	const guildIds = channelConfig.getGuildIds();
	const { agents, bufferUseCases } = createGuildAgents(ctx, guildIds);
	setupEventHandlers(ctx, bufferUseCases);

	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(ctx.root, "data"));
	gateway.onEmojiUsed((guildId, emojiName) => emojiUsageRepo.increment(guildId, emojiName));

	const ltmResources = await setupLtmRecording(ctx);

	const firstAgent = agents.values().next().value as PollingAgent | undefined;
	if (!firstAgent) {
		throw new Error("No guild agents available; cannot create defaultAgent for GuildRoutingAgent");
	}
	const routingAgent = new InstrumentedAiAgent(
		new GuildRoutingAgent(agents, firstAgent),
		metrics,
		"polling",
	);
	const scheduler = createHeartbeat(ctx.root, routingAgent, logger, metrics);
	const sessionGaugeTimer = startSessionGauge(sessions, metrics);
	setupShutdown(
		logger,
		scheduler,
		gateway,
		routingAgent,
		emojiUsageRepo,
		metricsServer,
		sessionGaugeTimer,
		ltmResources?.chatAdapter,
		ltmResources?.recorder,
	);

	logger.info(`[bootstrap] Polling mode for ${guildIds.length} guild(s): ${guildIds.join(", ")}`);
	await gateway.start();
	scheduler.start();
	for (const [guildId, agent] of agents) {
		agent.startPollingLoop().catch((err) => {
			logger.error(`[bootstrap] polling loop for guild ${guildId} unexpectedly rejected`, err);
		});
	}
}
