/* oxlint-disable max-dependencies, max-lines -- bootstrap file naturally requires many imports and lines for DI wiring */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { ContextBuilder } from "@vicissitude/agent/discord/context-builder";
import { DiscordAgent } from "@vicissitude/agent/discord/discord-agent";
import { GuildRouter } from "@vicissitude/agent/discord/router";
import { McBrainManager } from "@vicissitude/agent/minecraft/brain-manager";
import { SessionStore } from "@vicissitude/agent/session-store";
import { MessageIngestionService } from "@vicissitude/application/message-ingestion-service";
import { createGatewayServer } from "@vicissitude/gateway/server";
import { WsConnectionManager } from "@vicissitude/gateway/ws-handler";
import { SqliteBufferedEventStore } from "@vicissitude/infrastructure/store/sqlite-buffered-event-store";
import { CompositeLLMAdapter } from "@vicissitude/ltm/composite-llm-adapter";
import { LtmConversationRecorder } from "@vicissitude/ltm/conversation-recorder";
import { type EmbeddingPort, LtmFactReaderImpl } from "@vicissitude/ltm/fact-reader";
import { LtmChatAdapter } from "@vicissitude/ltm/ltm-chat-adapter";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import {
	PrometheusCollector,
	PrometheusServer,
	METRIC,
	InstrumentedAiAgent,
} from "@vicissitude/observability/metrics";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import { HeartbeatScheduler } from "@vicissitude/scheduling/heartbeat-scheduler";
import {
	type AppConfig,
	HEARTBEAT_CONFIG_RELATIVE_PATH,
	loadConfig,
} from "@vicissitude/shared/config";
import { OPENCODE_ALL_TOOLS_DISABLED } from "@vicissitude/shared/constants";
import type {
	AiAgent,
	ContextBuilderPort,
	Logger,
	MetricsCollector,
} from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { createDb, closeDb } from "@vicissitude/store/db";
import { SqliteMcStatusProvider } from "@vicissitude/store/mc-status-provider";
import { incrementEmoji } from "@vicissitude/store/queries";
import { createAivisSpeechSynthesizer, createEmotionToTtsStyleMapper } from "@vicissitude/tts";
import { spawn, type Subprocess } from "bun";

import { ChannelConfigLoader, type ChannelConfigData } from "./gateway/channel-config-loader.ts";
import { DiscordGateway } from "./gateway/discord.ts";

// ─── Store Layer ────────────────────────────────────────────────

export function createStoreLayer(config: AppConfig) {
	const db = createDb(config.dataDir);
	const sessionStore = new SessionStore(db);
	return { db, sessionStore };
}

// ─── Context Layer ──────────────────────────────────────────────

export function createContextLayer(
	config: AppConfig,
	root: string,
	db: StoreDb,
	embedding?: EmbeddingPort,
) {
	const ltmFactReader = new LtmFactReaderImpl(resolve(config.dataDir, "ltm"), embedding);
	const mcStatusProvider = config.minecraft
		? new SqliteMcStatusProvider(
				db,
				resolve(root, "data/context/minecraft/MINECRAFT-GOALS.md"),
				resolve(root, "context/minecraft/MINECRAFT-GOALS.md"),
			)
		: undefined;
	const contextBuilder = new ContextBuilder(
		resolve(root, "data/context"),
		resolve(root, "context"),
		ltmFactReader,
		mcStatusProvider,
	);
	return { ltmFactReader, mcStatusProvider, contextBuilder };
}

// ─── Guild Agents ───────────────────────────────────────────────

export function createGuildAgents(
	config: AppConfig,
	guildIds: string[],
	deps: {
		db: StoreDb;
		sessionStore: SessionStore;
		contextBuilder: ContextBuilderPort;
		logger: Logger;
		metrics?: MetricsCollector;
	},
): Map<string, DiscordAgent> {
	const agents = new Map<string, DiscordAgent>();

	for (const [index, guildId] of guildIds.entries()) {
		const agent = new DiscordAgent({
			guildId,
			db: deps.db,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			opencodePort: config.opencode.basePort + index,
			sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
			metrics: deps.metrics,
			model: { providerId: config.opencode.providerId, modelId: config.opencode.modelId },
		});
		agents.set(guildId, agent);
	}

	return agents;
}

// ─── Metrics ────────────────────────────────────────────────────

export function createMetrics(logger: Logger) {
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
	collector.registerCounter(METRIC.LTM_CONSOLIDATION_TICKS, "LTM consolidation scheduler ticks");
	collector.registerHistogram(
		METRIC.LTM_CONSOLIDATION_TICK_DURATION,
		"LTM consolidation tick duration in seconds",
	);
	// Token metrics
	collector.registerCounter(METRIC.LLM_INPUT_TOKENS, "LLM input tokens total");
	collector.registerCounter(METRIC.LLM_OUTPUT_TOKENS, "LLM output tokens total");
	collector.registerCounter(METRIC.LLM_CACHE_READ_TOKENS, "LLM cache read tokens total");
	collector.setGauge(METRIC.BOT_INFO, 1, { bot_name: "hua" });
	return { collector, server: new PrometheusServer(collector, logger) };
}

// ─── mc-check Reminder Sync ─────────────────────────────────────

/** config.minecraft の有無に応じて mc-check リマインダーの enabled を同期する */
function syncMcCheckReminder(configPath: string, minecraftEnabled: boolean, logger: Logger): void {
	if (!existsSync(configPath)) return;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
			reminders?: { id: string; enabled: boolean }[];
		};
		const mcCheck = raw.reminders?.find((r) => r.id === "mc-check");
		if (!mcCheck || mcCheck.enabled === minecraftEnabled) return;
		mcCheck.enabled = minecraftEnabled;
		writeFileSync(configPath, JSON.stringify(raw, null, 2));
		logger.info(
			`[bootstrap] mc-check reminder ${minecraftEnabled ? "enabled" : "disabled"} (synced with config.minecraft)`,
		);
	} catch {
		// パース失敗時はスキップ（HeartbeatScheduler がデフォルト設定で初期化する）
	}
}

/** ltm-consolidate リマインダーを削除する（MCP ツール廃止に伴う移行） */
function removeLtmConsolidateReminder(configPath: string, logger: Logger): void {
	if (!existsSync(configPath)) return;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
			reminders?: { id: string }[];
		};
		if (!raw.reminders) return;
		const idx = raw.reminders.findIndex((r) => r.id === "ltm-consolidate");
		if (idx === -1) return;
		raw.reminders.splice(idx, 1);
		writeFileSync(configPath, JSON.stringify(raw, null, 2));
		logger.info("[bootstrap] Removed ltm-consolidate reminder (consolidation is now automatic)");
	} catch {
		// パース失敗時はスキップ
	}
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

// ─── LTM Recording ─────────────────────────────────────────────

interface LtmResources {
	chatAdapter: LtmChatAdapter;
	recorder: LtmConversationRecorder;
	consolidationScheduler: ConsolidationScheduler;
}

export function setupLtmRecording(
	config: AppConfig,
	logger: Logger,
	metricsCollector?: PrometheusCollector,
	embeddingAdapter?: OllamaEmbeddingAdapter,
): LtmResources | undefined {
	const ltmPort = config.opencode.basePort - 2;
	const dataDir = resolve(config.dataDir, "ltm");

	try {
		const ltmSessionPort = new OpencodeSessionAdapter({
			port: ltmPort,
			mcpServers: {},
			builtinTools: OPENCODE_ALL_TOOLS_DISABLED,
		});
		const chatAdapter = new LtmChatAdapter(
			ltmSessionPort,
			config.ltm.providerId,
			config.ltm.modelId,
		);

		const ollama =
			embeddingAdapter ??
			new OllamaEmbeddingAdapter(config.ltm.ollamaBaseUrl, config.ltm.embeddingModel);
		const llm = new CompositeLLMAdapter(chatAdapter, ollama);
		const recorder = new LtmConversationRecorder(llm, dataDir);
		const consolidationScheduler = new ConsolidationScheduler(recorder, logger, metricsCollector);

		logger.info(`[bootstrap] LTM auto-recording enabled (port=${ltmPort})`);
		return { chatAdapter, recorder, consolidationScheduler };
	} catch (err) {
		logger.error("[bootstrap] LTM auto-recording init failed, continuing without LTM", err);
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
			bufferEvent: msg.authorId !== selfUserId,
		});
		if (msg.guildId && msg.authorId !== selfUserId) {
			const agent = agents.get(msg.guildId);
			if (!agent) {
				logger.warn(`[bootstrap] no agent for guild ${msg.guildId}, message will not be processed`);
			}
			agent?.ensurePolling();
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
			agent?.ensurePolling();
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
	const exitPromise = proc.exited.then(() => processDied as typeof processDied);
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

async function startCoreMcp(config: AppConfig, root: string, logger: Logger): Promise<Subprocess> {
	const coreEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		DISCORD_TOKEN: config.discordToken,
		CORE_MCP_PORT: String(config.coreMcpPort),
		OLLAMA_BASE_URL: config.ltm.ollamaBaseUrl,
		LTM_EMBEDDING_MODEL: config.ltm.embeddingModel,
		LTM_DATA_DIR: resolve(config.dataDir, "ltm"),
		DATA_DIR: resolve(root, "data"),
	};

	const coreProcess = spawn({
		cmd: ["bun", "run", resolve(root, "dist/core-server.js")],
		env: coreEnv,
		stdout: "inherit",
		stderr: "inherit",
	});

	const port = String(config.coreMcpPort);
	const status = await waitForMcpReady(coreProcess, port);
	if (status === "died") {
		throw new Error(`[bootstrap] Core MCP process exited with code ${coreProcess.exitCode}`);
	}
	if (status === "timeout") {
		coreProcess.kill();
		throw new Error("[bootstrap] Core MCP server health check timed out");
	}

	logger.info(`[bootstrap] Core MCP server started (port=${config.coreMcpPort})`);
	return coreProcess;
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

	// Store
	const { db, sessionStore } = createStoreLayer(config);

	// Embedding adapter (shared between context layer and LTM recording)
	const ollamaEmbedding = new OllamaEmbeddingAdapter(
		config.ltm.ollamaBaseUrl,
		config.ltm.embeddingModel,
	);

	// Context
	const { ltmFactReader, contextBuilder } = createContextLayer(config, root, db, ollamaEmbedding);

	// Metrics
	const metrics = createMetrics(logger);
	metrics.server.start();

	// Channel config
	const channelConfig = await loadChannelConfig(root);

	// Discord Gateway
	const gateway = new DiscordGateway(config.discordToken, logger);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	// Gateway WebSocket server (with optional TTS)
	const ttsSynthesizer = config.tts
		? createAivisSpeechSynthesizer({
				baseUrl: config.tts.baseUrl,
				speakerId: config.tts.speakerId,
			})
		: undefined;
	const ttsStyleMapper = config.tts ? createEmotionToTtsStyleMapper() : undefined;
	const wsManager = new WsConnectionManager({
		ttsSynthesizer,
		ttsStyleMapper,
	});
	const gatewayServer = createGatewayServer(config.gatewayPort, wsManager);
	logger.info(
		`[bootstrap] Gateway server started (port=${config.gatewayPort}, tts=${!!config.tts})`,
	);

	// Core MCP + Minecraft MCP (start in parallel)
	const coreReady = startCoreMcp(config, root, logger);
	const mcReady = startMinecraftMcp(config, root, logger);

	// Guild agents
	const guildIds = channelConfig.getGuildIds();
	const agents = createGuildAgents(config, guildIds, {
		db,
		sessionStore,
		contextBuilder,
		logger,
		metrics: metrics.collector,
	});

	// LTM recording
	const ltmResources = setupLtmRecording(config, logger, metrics.collector, ollamaEmbedding);
	const ingestionService = new MessageIngestionService({
		eventStore: new SqliteBufferedEventStore(db),
		logger,
		recorder: ltmResources?.recorder,
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

	// Routing agent
	const firstAgent = agents.values().next().value as AiAgent | undefined;
	if (!firstAgent) {
		throw new Error("No guild agents available; cannot create defaultAgent for GuildRouter");
	}
	const routingAgent = new InstrumentedAiAgent(
		new GuildRouter(agents, firstAgent),
		metrics.collector,
		"polling",
	);

	// Heartbeat — リマインダー同期
	const heartbeatConfigPath = resolve(root, HEARTBEAT_CONFIG_RELATIVE_PATH);
	syncMcCheckReminder(heartbeatConfigPath, !!config.minecraft, logger);
	removeLtmConsolidateReminder(heartbeatConfigPath, logger);
	const heartbeatScheduler = new HeartbeatScheduler(routingAgent, logger, metrics.collector, root);

	// Session gauge
	const sessionGaugeTimer = startSessionGauge(sessionStore, metrics.collector);

	// MCP processes
	const coreProcess = await coreReady;
	const mcProcess = await mcReady;

	// Minecraft brain manager
	let mcBrainManager: McBrainManager | undefined;
	if (config.minecraft) {
		mcBrainManager = new McBrainManager({
			db,
			sessionStore,
			logger,
			root,
			// ギルドエージェントが basePort + 0..N-1 を使うため、Minecraft エージェントは basePort + N を使用
			opencodePort: config.opencode.basePort + guildIds.length,
			providerId: config.mcBrain.providerId,
			modelId: config.mcBrain.modelId,
			sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
		});
	}

	// Graceful shutdown
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down...");
		// Force exit after 5 seconds if graceful shutdown hangs
		const forceTimer = setTimeout(() => process.exit(1), 5000);
		try {
			clearInterval(sessionGaugeTimer);
			await ltmResources?.consolidationScheduler.stop();
			heartbeatScheduler.stop();
			gateway.stop();
			await gatewayServer.stop();
			mcBrainManager?.stop();
			routingAgent.stop();
			metrics.server.stop();
			await ltmResources?.chatAdapter.close();
			await ltmResources?.recorder.close();
			await ltmFactReader.close();
			coreProcess.kill();
			mcProcess?.kill();
			closeDb(db);
		} catch (err) {
			logger.error("Error during shutdown:", err);
		}
		clearTimeout(forceTimer);
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	// Start
	logger.info(`[bootstrap] Polling mode for ${guildIds.length} guild(s): ${guildIds.join(", ")}`);
	await gateway.start();
	heartbeatScheduler.start();
	ltmResources?.consolidationScheduler.start();
	// DiscordAgent は lazy start: 最初の send() 呼び出しで自動的にポーリングループが起動する
	mcBrainManager?.start();
}
