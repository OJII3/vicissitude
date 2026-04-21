/* oxlint-disable max-dependencies, max-lines -- bootstrap file naturally requires many imports and lines for DI wiring */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

import { ContextBuilder, type ContextFileName } from "@vicissitude/agent/discord/context-builder";
import { formatDiscordMessage } from "@vicissitude/agent/discord/message-formatter";
import { DiscordAgent } from "@vicissitude/agent/discord/discord-agent";
import { createConversationProfile } from "@vicissitude/agent/discord/profile";
import { GuildRouter } from "@vicissitude/agent/discord/router";
import { mcpServerConfigs } from "@vicissitude/agent/mcp-config";
import { McBrainManager } from "@vicissitude/agent/minecraft/brain-manager";
import { SessionStore } from "@vicissitude/agent/session-store";
import { HeartbeatService } from "@vicissitude/application/heartbeat-service";
import { MessageIngestionService } from "@vicissitude/application/message-ingestion-service";
import { createGatewayServer } from "@vicissitude/gateway/server";
import { WsConnectionManager } from "@vicissitude/gateway/ws-handler";
import { MemoryChatAdapter } from "@vicissitude/memory/chat-adapter";
import { CompositeLLMAdapter } from "@vicissitude/memory/composite-llm-adapter";
import { MemoryConversationRecorder } from "@vicissitude/memory/conversation-recorder";
import { MemoryFactReaderImpl } from "@vicissitude/memory/fact-reader";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import {
	PrometheusCollector,
	PrometheusServer,
	METRIC,
	InstrumentedAiAgent,
} from "@vicissitude/observability/metrics";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { OPENCODE_ALL_TOOLS_DISABLED } from "@vicissitude/opencode/constants";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";
import { HEARTBEAT_CONFIG_RELATIVE_PATH } from "@vicissitude/scheduling/heartbeat-helpers";
import { HeartbeatScheduler } from "@vicissitude/scheduling/heartbeat-scheduler";
import type {
	AiAgent,
	ContextBuilderPort,
	Logger,
	MemoryFactReader,
	MetricsCollector,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { closeDb, createDb } from "@vicissitude/store/db";
import { SqliteMoodStore } from "@vicissitude/store/mood-store";
import { incrementEmoji } from "@vicissitude/store/queries";
import { AivisSpeechSynthesizer, createEmotionToTtsStyleMapper } from "@vicissitude/tts";
import { spawn, type Subprocess } from "bun";

import { type AppConfig, loadConfig } from "./config.ts";
import { ChannelConfigLoader, type ChannelConfigData } from "./gateway/channel-config-loader.ts";
import { DiscordGateway } from "./gateway/discord.ts";
import {
	migrateMemoryDir,
	removeLegacyConsolidateReminder,
	syncMcCheckReminder,
} from "./migrations.ts";
import { createPortLayout } from "./port-allocator.ts";
import { createShutdown } from "./shutdown.ts";

// ─── Store Layer ────────────────────────────────────────────────

export function createStoreLayer(config: AppConfig) {
	const db = createDb(config.dataDir);
	const sessionStore = new SessionStore(db);
	return { db, sessionStore };
}

// ─── Context Layer ──────────────────────────────────────────────

export function createContextLayer(config: AppConfig, root: string, factReader?: MemoryFactReader) {
	const excludeFiles: ReadonlySet<ContextFileName> | undefined = config.minecraft
		? undefined
		: new Set<ContextFileName>(["TOOLS-MINECRAFT.md"]);
	const contextBuilder = new ContextBuilder(
		resolve(root, "data/context"),
		resolve(root, "context"),
		factReader,
		excludeFiles,
	);
	return { contextBuilder };
}

// ─── Guild Agents ───────────────────────────────────────────────

function createFileSessionSummaryWriter(overlayDir: string): SessionSummaryWriter {
	return {
		write(guildId: string, content: string): Promise<void> {
			const dir = resolve(overlayDir, `guilds/${guildId}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(resolve(dir, "SESSION-SUMMARY.md"), content);
			return Promise.resolve();
		},
	};
}

/** core MCP stdio プロセスに渡す環境変数を組み立てる */
export function buildCoreEnvironment(config: AppConfig, root: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		DISCORD_TOKEN: config.discordToken,
		OLLAMA_BASE_URL: config.memory.ollamaBaseUrl,
		MEMORY_EMBEDDING_MODEL: config.memory.embeddingModel,
		MEMORY_DATA_DIR: resolve(config.dataDir, "memory"),
		DATA_DIR: resolve(root, "data"),
		EMOTION_CHAT_MODEL: process.env.EMOTION_CHAT_MODEL ?? "gemma3",
	};

	if (config.spotify) {
		env.SPOTIFY_CLIENT_ID = config.spotify.clientId;
		env.SPOTIFY_CLIENT_SECRET = config.spotify.clientSecret;
		env.SPOTIFY_REFRESH_TOKEN = config.spotify.refreshToken;
		if (config.spotify.recommendPlaylistId) {
			env.SPOTIFY_RECOMMEND_PLAYLIST_ID = config.spotify.recommendPlaylistId;
		}
	}

	if (config.genius) {
		env.GENIUS_ACCESS_TOKEN = config.genius.accessToken;
	}

	if (config.minecraft) {
		env.MC_HOST = config.minecraft.host;
	}

	return env;
}

export function createGuildAgents(
	config: AppConfig,
	guildIds: string[],
	deps: {
		db: StoreDb;
		sessionStore: SessionStorePort;
		contextBuilder: ContextBuilderPort;
		logger: Logger;
		metrics?: MetricsCollector;
		summaryWriter?: SessionSummaryWriter;
		/** agentId プレフィックス（デフォルト: "discord"） */
		agentIdPrefix?: string;
		/** ポート番号のオフセット（デフォルト: 0）。basePort + portOffset + index でポートを決定 */
		portOffset?: number;
		appRoot: string;
		coreEnvironment: Record<string, string>;
		/** proactive compaction のトークン閾値。省略時は proactive compaction 無効 */
		compactionTokenThreshold?: number;
		/** compaction 間のクールダウン（ms） */
		compactionCooldownMs?: number;
	},
): Map<string, DiscordAgent> {
	const agents = new Map<string, DiscordAgent>();
	const portOffset = deps.portOffset ?? 0;

	for (const [index, guildId] of guildIds.entries()) {
		const agentIdPrefix = deps.agentIdPrefix ?? "discord";
		const agentId = `${agentIdPrefix}:${guildId}`;
		const profile = createConversationProfile({
			...config.opencode,
			mcpServers: mcpServerConfigs(agentId, {
				appRoot: deps.appRoot,
				coreEnvironment: deps.coreEnvironment,
			}),
			minecraftEnabled: !!config.minecraft,
		});
		const sessionPort = new OpencodeSessionAdapter({
			port: config.opencode.basePort + portOffset + index,
			mcpServers: profile.mcpServers,
			builtinTools: profile.builtinTools,
			temperature: 0.7,
			logger: deps.logger,
		});
		const agent = new DiscordAgent({
			guildId,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort,
			sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
			metrics: deps.metrics,
			profile,
			summaryWriter: deps.summaryWriter,
			agentIdPrefix: deps.agentIdPrefix,
			compactionTokenThreshold: deps.compactionTokenThreshold,
			compactionCooldownMs: deps.compactionCooldownMs,
		});
		agents.set(guildId, agent);
	}

	return agents;
}

// ─── Metrics ────────────────────────────────────────────────────

export function createMetrics(logger: Logger, port: number) {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.DISCORD_MESSAGES_RECEIVED, "Discord messages received");
	collector.registerCounter(METRIC.AI_REQUESTS, "AI agent requests");
	collector.registerCounter(METRIC.HEARTBEAT_TICKS, "Heartbeat scheduler ticks");
	collector.registerCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED, "Heartbeat reminders executed");
	collector.registerGauge(METRIC.BOT_INFO, "Bot information");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "AI request duration in seconds");
	collector.registerHistogram(METRIC.HEARTBEAT_TICK_DURATION, "Heartbeat tick duration in seconds");
	collector.registerGauge(METRIC.LLM_ACTIVE_SESSIONS, "Registered LLM sessions");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "LLM sessions currently processing");
	collector.registerCounter(
		METRIC.MEMORY_CONSOLIDATION_TICKS,
		"Memory consolidation scheduler ticks",
	);
	collector.registerHistogram(
		METRIC.MEMORY_CONSOLIDATION_TICK_DURATION,
		"Memory consolidation tick duration in seconds",
	);
	// Token metrics
	collector.registerCounter(METRIC.LLM_INPUT_TOKENS, "LLM input tokens total");
	collector.registerCounter(METRIC.LLM_OUTPUT_TOKENS, "LLM output tokens total");
	collector.registerCounter(METRIC.LLM_CACHE_READ_TOKENS, "LLM cache read tokens total");
	// Cost metrics
	collector.registerCounter(METRIC.LLM_COST_DOLLARS, "LLM cost in US dollars");
	// Session error metrics
	collector.registerCounter(METRIC.SESSION_ERRORS, "Session errors total");
	collector.registerCounter(METRIC.SESSION_RESTARTS, "Session restarts total");
	collector.registerCounter(METRIC.SESSION_RETRIES, "Session retries total");
	collector.setGauge(METRIC.BOT_INFO, 1, { bot_name: "hua" });
	return { collector, server: new PrometheusServer(collector, logger, port) };
}

// ─── Channel Config ─────────────────────────────────────────────

async function loadChannelConfig(root: string): Promise<ChannelConfigLoader> {
	const overlayChannels = resolve(root, "data/context/channels.json");
	const baseChannels = resolve(root, "context/channels.json");
	const channelsJson = existsSync(overlayChannels)
		? await Bun.file(overlayChannels).json()
		: await Bun.file(baseChannels).json();
	return new ChannelConfigLoader(channelsJson as ChannelConfigData);
}

// ─── Memory Recording ───────────────────────────────────────────

interface MemoryResources {
	chatAdapter: MemoryChatAdapter;
	recorder: MemoryConversationRecorder;
	consolidationScheduler: ConsolidationScheduler;
}

export function setupMemoryRecording(
	config: AppConfig,
	logger: Logger,
	opts: {
		memoryPort: number;
		metricsCollector?: PrometheusCollector;
		embeddingAdapter?: OllamaEmbeddingAdapter;
	},
): MemoryResources | undefined {
	const dataDir = resolve(config.dataDir, "memory");

	try {
		const memorySessionPort = new OpencodeSessionAdapter({
			port: opts.memoryPort,
			mcpServers: {},
			builtinTools: OPENCODE_ALL_TOOLS_DISABLED,
		});
		const chatAdapter = new MemoryChatAdapter(
			memorySessionPort,
			config.memory.providerId,
			config.memory.modelId,
			logger,
		);

		const ollama =
			opts.embeddingAdapter ??
			new OllamaEmbeddingAdapter(config.memory.ollamaBaseUrl, config.memory.embeddingModel);
		const llm = new CompositeLLMAdapter(chatAdapter, ollama);
		const recorder = new MemoryConversationRecorder(llm, dataDir);
		const consolidationScheduler = new ConsolidationScheduler(
			recorder,
			logger,
			opts.metricsCollector,
		);

		logger.info(`[bootstrap] Memory auto-recording enabled (port=${opts.memoryPort})`);
		return { chatAdapter, recorder, consolidationScheduler };
	} catch (err) {
		logger.error("[bootstrap] Memory auto-recording init failed, continuing without memory", err);
		return undefined;
	}
}

// ─── Event Handlers ─────────────────────────────────────────────

function setupEventHandlers(deps: {
	gateway: DiscordGateway;
	ingestionService: MessageIngestionService;
	metricsCollector: PrometheusCollector;
	agents: Map<string, DiscordAgent>;
	logger: Logger;
}): void {
	const { gateway, ingestionService, metricsCollector, agents, logger } = deps;
	gateway.onHomeChannelMessage((msg) => {
		const selfUserId = gateway.getClient()?.user?.id;
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "home" });
		ingestionService.handleIncomingMessage(msg, {
			recordConversation: true,
		});
		if (msg.guildId && msg.authorId !== selfUserId) {
			const agent = agents.get(msg.guildId);
			if (!agent) {
				logger.warn(`[bootstrap] no agent for guild ${msg.guildId}, message will not be processed`);
			}
			void agent?.send({ sessionKey: "home", message: formatDiscordMessage(msg) });
		}
		return Promise.resolve();
	});

	gateway.onMessage((msg) => {
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			channel_type: "mention",
		});
		ingestionService.handleIncomingMessage(msg);
		if (msg.guildId) {
			const agent = agents.get(msg.guildId);
			if (!agent) {
				logger.warn(`[bootstrap] no agent for guild ${msg.guildId}, mention will not be processed`);
			}
			void agent?.send({ sessionKey: "mention", message: formatDiscordMessage(msg) });
		}
		return Promise.resolve();
	});
}

// ─── MCP Process Management ─────────────────────────────────────

async function waitForMcpReady(
	proc: Subprocess,
	port: string,
): Promise<"ready" | "died" | "timeout"> {
	const processDied = Symbol("died");
	const exitPromise = proc.exited.then(() => processDied);
	const maxRetries = 30;
	/* oxlint-disable no-await-in-loop -- intentional sequential polling */
	for (let i = 0; i < maxRetries; i++) {
		const result = await Promise.race([
			fetch(`http://localhost:${port}/health`)
				.then((res) => res.status)
				.catch(() => null),
			exitPromise,
		]);
		if (result === processDied) return "died";
		if (typeof result === "number" && result >= 200 && result < 300) return "ready";
		await Bun.sleep(500);
	}
	/* oxlint-enable no-await-in-loop */
	return "timeout";
}

async function startMinecraftMcp(
	config: AppConfig,
	root: string,
	logger: Logger,
): Promise<Subprocess | null> {
	if (!config.minecraft) return null;

	const mcEnv: Record<string, string> = {
		// 子プロセスに必要な環境変数のみを明示的に渡す
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		MC_HOST: config.minecraft.host,
		MC_PORT: String(config.minecraft.port),
		MC_USERNAME: config.minecraft.username,
		MC_AUTH_MODE: config.minecraft.authMode,
		MC_MCP_PORT: String(config.minecraft.mcpPort),
		DATA_DIR: resolve(root, "data"),
	};
	if (config.minecraft.version) mcEnv.MC_VERSION = config.minecraft.version;
	if (config.minecraft.profilesFolder) mcEnv.MC_PROFILES_FOLDER = config.minecraft.profilesFolder;

	const mcProcess = spawn({
		cmd: ["bun", "run", resolve(root, "dist/minecraft-server.js")],
		env: mcEnv,
		stdout: "inherit",
		stderr: "inherit",
	});

	const port = String(config.minecraft.mcpPort);
	const status = await waitForMcpReady(mcProcess, port);
	if (status === "died") {
		logger.error(`[bootstrap] Minecraft MCP process exited with code ${mcProcess.exitCode}`);
		return null;
	}
	if (status === "timeout") {
		logger.warn(
			"[bootstrap] Minecraft MCP server health check timed out, but keeping process alive",
		);
		return mcProcess;
	}

	logger.info("[bootstrap] Minecraft MCP server started");
	return mcProcess;
}

// ─── Session Gauge ──────────────────────────────────────────────

function startSessionGauge(
	sessionStore: SessionStore,
	metricsCollector: PrometheusCollector,
): ReturnType<typeof setInterval> {
	const update = () => metricsCollector.setGauge(METRIC.LLM_ACTIVE_SESSIONS, sessionStore.count());
	update();
	return setInterval(update, 30_000);
}

// ─── Main Bootstrap ─────────────────────────────────────────────

export async function bootstrap(): Promise<void> {
	const config = loadConfig();
	const root = process.env.APP_ROOT ?? resolve(import.meta.dirname, "..");
	const logger = new ConsoleLogger();

	// Migrate data/ltm → data/memory
	migrateMemoryDir(config.dataDir, logger);

	// Store
	const { db, sessionStore } = createStoreLayer(config);

	// Embedding adapter (for memory recording)
	const ollamaEmbedding = new OllamaEmbeddingAdapter(
		config.memory.ollamaBaseUrl,
		config.memory.embeddingModel,
	);

	// Fact reader (for context injection)
	const memoryDataDir = resolve(config.dataDir, "memory");
	const factReader = new MemoryFactReaderImpl(memoryDataDir, ollamaEmbedding);

	// Context
	const { contextBuilder } = createContextLayer(config, root, factReader);

	// Metrics
	const metricsPort = Number(process.env.METRICS_PORT) || 9091;
	const metrics = createMetrics(logger, metricsPort);
	metrics.server.start();

	// Channel config
	const channelConfig = await loadChannelConfig(root);

	// Discord Gateway
	const gateway = new DiscordGateway(config.discordToken, logger);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	// Gateway WebSocket server (with optional TTS)
	const ttsSynthesizer = config.tts
		? new AivisSpeechSynthesizer({
				baseUrl: config.tts.baseUrl,
				speakerId: config.tts.speakerId,
				logger,
			})
		: undefined;
	const ttsStyleMapper = config.tts ? createEmotionToTtsStyleMapper() : undefined;
	const moodStore = new SqliteMoodStore(db);
	const wsManager = new WsConnectionManager({
		ttsSynthesizer,
		ttsStyleMapper,
		moodReader: moodStore,
		logger,
	});
	const gatewayServer = createGatewayServer(config.gatewayPort, wsManager);
	logger.info(
		`[bootstrap] Gateway server started (port=${config.gatewayPort}, tts=${!!config.tts})`,
	);

	// Minecraft MCP (HTTP, start async)
	const mcReady = startMinecraftMcp(config, root, logger);

	// Core MCP environment (stdio プロセスに渡す環境変数)
	const coreEnvironment = buildCoreEnvironment(config, root);

	// Port layout
	const guildIds = channelConfig.getGuildIds();
	const ports = createPortLayout(config.opencode.basePort, guildIds.length);

	// Guild agents
	const summaryWriter = createFileSessionSummaryWriter(resolve(root, "data/context"));
	const agents = createGuildAgents(config, guildIds, {
		db,
		sessionStore,
		contextBuilder,
		logger,
		metrics: metrics.collector,
		summaryWriter,
		appRoot: root,
		coreEnvironment,
		compactionTokenThreshold: 20_000,
	});

	// Memory recording
	const memoryResources = setupMemoryRecording(config, logger, {
		memoryPort: ports.memory(),
		metricsCollector: metrics.collector,
		embeddingAdapter: ollamaEmbedding,
	});
	const ingestionService = new MessageIngestionService({
		logger,
		recorder: memoryResources?.recorder,
	});

	// Event handlers
	setupEventHandlers({
		gateway,
		ingestionService,
		metricsCollector: metrics.collector,
		agents,
		logger,
	});

	// Emoji tracking
	gateway.onEmojiUsed((guildId, emojiName) => incrementEmoji(db, guildId, emojiName));

	// Routing agent (ユーザーメッセージ用)
	const firstAgent = agents.values().next().value as AiAgent | undefined;
	if (!firstAgent) {
		throw new Error("No guild agents available; cannot create defaultAgent for GuildRouter");
	}
	const routingAgent = new InstrumentedAiAgent(
		new GuildRouter(agents, firstAgent),
		metrics.collector,
		"polling",
	);

	// Heartbeat 専用エージェント（ユーザーメッセージとセッションを分離し、遅延を防ぐ）
	const heartbeatAgents = createGuildAgents(config, guildIds, {
		db,
		sessionStore,
		contextBuilder,
		logger,
		metrics: metrics.collector,
		agentIdPrefix: "discord:heartbeat",
		portOffset: ports.heartbeatOffset,
		appRoot: root,
		coreEnvironment,
		compactionTokenThreshold: 20_000,
	});
	const firstHeartbeatAgent = heartbeatAgents.values().next().value as AiAgent | undefined;
	if (!firstHeartbeatAgent) {
		throw new Error(
			"No heartbeat agents available; cannot create defaultAgent for heartbeat GuildRouter",
		);
	}
	const heartbeatRouter = new InstrumentedAiAgent(
		new GuildRouter(heartbeatAgents, firstHeartbeatAgent),
		metrics.collector,
		"heartbeat",
	);

	// Heartbeat — リマインダー同期
	const heartbeatConfigPath = resolve(root, HEARTBEAT_CONFIG_RELATIVE_PATH);
	syncMcCheckReminder(heartbeatConfigPath, !!config.minecraft, logger);
	removeLegacyConsolidateReminder(heartbeatConfigPath, logger);
	const heartbeatScheduler = new HeartbeatScheduler({
		configRepo: new JsonHeartbeatConfigRepository(heartbeatConfigPath),
		heartbeatService: new HeartbeatService({ agent: heartbeatRouter, logger }),
		logger,
		metrics: metrics.collector,
	});

	// Session gauge
	const sessionGaugeTimer = startSessionGauge(sessionStore, metrics.collector);

	// MCP processes (Minecraft のみ HTTP、core は stdio で OpenCode が管理)
	const mcProcess = await mcReady;

	// Minecraft brain manager
	let mcBrainManager: McBrainManager | undefined;
	if (config.minecraft) {
		mcBrainManager = new McBrainManager({
			db,
			sessionStore,
			logger,
			root,
			opencodePort: ports.minecraft(),
			providerId: config.mcBrain.providerId,
			modelId: config.mcBrain.modelId,
			sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
			mcHost: config.minecraft.host,
			mcMcpPort: String(config.minecraft.mcpPort),
			compactionTokenThreshold: 20_000,
		});
	}

	// Graceful shutdown
	const shutdown = createShutdown({
		logger,
		sessionGaugeTimer,
		consolidationScheduler: memoryResources?.consolidationScheduler,
		heartbeatScheduler,
		gateway,
		gatewayServer,
		mcBrainManager,
		heartbeatRouter,
		routingAgent,
		metricsServer: metrics.server,
		factReader,
		chatAdapter: memoryResources?.chatAdapter,
		recorder: memoryResources?.recorder,
		mcProcess,
		closeDb: () => closeDb(db),
	});
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	// Start
	logger.info(`[bootstrap] Polling mode for ${guildIds.length} guild(s): ${guildIds.join(", ")}`);
	await gateway.start();
	heartbeatScheduler.start();
	memoryResources?.consolidationScheduler.start();
	// DiscordAgent は lazy start: 最初の send() 呼び出しで自動的にポーリングループが起動する
	mcBrainManager?.start();
}
