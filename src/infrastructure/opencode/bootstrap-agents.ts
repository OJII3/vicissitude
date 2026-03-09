/* oxlint-disable max-dependencies -- bootstrap file naturally requires many imports for DI wiring */
import { resolve } from "path";

import { spawn, type Subprocess } from "bun";

import { BufferEventUseCase } from "../../application/use-cases/buffer-event.use-case.ts";
import { RecordConversationUseCase } from "../../application/use-cases/record-conversation.use-case.ts";
import type { BootstrapContext } from "../../bootstrap-context.ts";
import {
	createConsolidationScheduler,
	createHeartbeat,
	setupShutdown,
	startSessionGauge,
} from "../../bootstrap-helpers.ts";
import type { IncomingMessage } from "../../domain/ports/message-gateway.port.ts";
import { CompositeLLMAdapter } from "../fenghuang/composite-llm-adapter.ts";
import { FenghuangChatAdapter } from "../fenghuang/fenghuang-chat-adapter.ts";
import { FenghuangConversationRecorder } from "../fenghuang/fenghuang-conversation-recorder.ts";
import { InstrumentedAiAgent } from "../metrics/instrumented-ai-agent.ts";
import { METRIC } from "../metrics/metric-names.ts";
import { OllamaEmbeddingAdapter } from "../ollama/ollama-embedding-adapter.ts";
import { FileEventBuffer } from "../persistence/file-event-buffer.ts";
import { JsonEmojiUsageRepository } from "../persistence/json-emoji-usage-repository.ts";
import type { IntervalConsolidationScheduler } from "../scheduler/interval-consolidation-scheduler.ts";
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
	ltmUseCase?: RecordConversationUseCase,
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
		if (ltmUseCase) {
			try {
				await ltmUseCase.execute(msg);
			} catch (err) {
				logger.error("[ltm-record] failed to record message", err);
			}
		}
	});
	gateway.onMessage(async (msg) => {
		metrics.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "mention" });
		await routeBuffer(msg);
	});
}

interface LtmResources {
	chatAdapter: FenghuangChatAdapter;
	recorder: FenghuangConversationRecorder;
	useCase: RecordConversationUseCase;
	consolidationScheduler: IntervalConsolidationScheduler;
}

async function setupLtmRecording(ctx: BootstrapContext): Promise<LtmResources | undefined> {
	const { logger } = ctx;
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
		const consolidationScheduler = createConsolidationScheduler(recorder, logger, ctx.metrics);

		logger.info(`[bootstrap] LTM auto-recording enabled (port=${ltmPort})`);
		return { chatAdapter, recorder, useCase, consolidationScheduler };
	} catch (err) {
		logger.error("[bootstrap] LTM auto-recording init failed, continuing without LTM", err);
		return undefined;
	}
}

let minecraftProcess: Subprocess | null = null;

async function startMinecraftMcp(ctx: BootstrapContext): Promise<void> {
	if (!process.env.MC_HOST) return;

	const mcEnv: Record<string, string> = {
		...(process.env as Record<string, string>),
		MC_HOST: process.env.MC_HOST,
	};
	if (process.env.MC_PORT) mcEnv.MC_PORT = process.env.MC_PORT;
	if (process.env.MC_USERNAME) mcEnv.MC_USERNAME = process.env.MC_USERNAME;
	if (process.env.MC_VERSION) mcEnv.MC_VERSION = process.env.MC_VERSION;
	if (process.env.MC_MCP_PORT) mcEnv.MC_MCP_PORT = process.env.MC_MCP_PORT;

	minecraftProcess = spawn({
		cmd: ["bun", "run", resolve(ctx.root, "src/mcp/minecraft-server.ts")],
		env: mcEnv,
		stdout: "inherit",
		stderr: "inherit",
	});

	// サーバーの起動待ち（HTTP ヘルスチェック — 逐次ポーリングが意図的）
	const port = process.env.MC_MCP_PORT ?? "3001";
	const maxRetries = 30;
	/* oxlint-disable no-await-in-loop -- intentional sequential polling */
	for (let i = 0; i < maxRetries; i++) {
		try {
			const res = await fetch(`http://localhost:${port}/mcp`, { method: "GET" });
			// GET on /mcp returns 405 (Method Not Allowed) or similar when server is up
			if (res.status !== 0) break;
		} catch {
			// サーバーがまだ起動していない
		}
		await Bun.sleep(500);
	}
	/* oxlint-enable no-await-in-loop */
	ctx.logger.info("[bootstrap] Minecraft MCP server started");
}

export async function bootstrapAgents(ctx: BootstrapContext): Promise<void> {
	const { gateway, channelConfig, logger, metrics, metricsServer, sessions } = ctx;

	await startMinecraftMcp(ctx);

	const guildIds = channelConfig.getGuildIds();
	const { agents, bufferUseCases } = createGuildAgents(ctx, guildIds);

	const ltmResources = await setupLtmRecording(ctx);
	setupEventHandlers(ctx, bufferUseCases, ltmResources?.useCase);

	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(ctx.root, "data"));
	gateway.onEmojiUsed((guildId, emojiName) => emojiUsageRepo.increment(guildId, emojiName));

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
		ctx.ltmFactReader,
		ltmResources?.consolidationScheduler,
		minecraftProcess,
	);

	logger.info(`[bootstrap] Polling mode for ${guildIds.length} guild(s): ${guildIds.join(", ")}`);
	await gateway.start();
	scheduler.start();
	ltmResources?.consolidationScheduler.start();
	for (const [guildId, agent] of agents) {
		agent.startPollingLoop().catch((err) => {
			logger.error(`[bootstrap] polling loop for guild ${guildId} unexpectedly rejected`, err);
		});
	}
}
