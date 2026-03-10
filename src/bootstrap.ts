/* oxlint-disable max-dependencies, max-lines -- bootstrap file naturally requires many imports and lines for DI wiring */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { spawn, type Subprocess } from "bun";

import { ContextBuilder } from "./agent/context-builder.ts";
import { McSubBrainManager } from "./agent/mc-sub-brain-manager.ts";
import { mcpServerConfigs, mcpMinecraftSubBrainConfigs } from "./agent/mcp-config.ts";
import { createConversationProfile } from "./agent/profiles/conversation.ts";
import { createMinecraftProfile } from "./agent/profiles/minecraft.ts";
import { GuildRouter } from "./agent/router.ts";
import { AgentRunner } from "./agent/runner.ts";
import { SessionStore } from "./agent/session-store.ts";
import { HEARTBEAT_CONFIG_RELATIVE_PATH, loadConfig } from "./core/config.ts";
import { OPENCODE_ALL_TOOLS_DISABLED } from "./core/constants.ts";
import type { AiAgent, Logger } from "./core/types.ts";
import { CompositeLLMAdapter } from "./fenghuang/composite-llm-adapter.ts";
import { FenghuangChatAdapter } from "./fenghuang/fenghuang-chat-adapter.ts";
import { FenghuangConversationRecorder } from "./fenghuang/fenghuang-conversation-recorder.ts";
import { FenghuangFactReader } from "./fenghuang/fenghuang-fact-reader.ts";
import { ChannelConfigLoader, type ChannelConfigData } from "./gateway/channel-config-loader.ts";
import { DiscordGateway } from "./gateway/discord.ts";
import { recordLtmMessage, bufferIncomingMessage } from "./gateway/message-handlers.ts";
import { ConsoleLogger } from "./observability/logger.ts";
import {
	PrometheusCollector,
	PrometheusServer,
	METRIC,
	InstrumentedAiAgent,
} from "./observability/metrics.ts";
import { OllamaEmbeddingAdapter } from "./ollama/ollama-embedding-adapter.ts";
import { OpencodeSessionAdapter } from "./opencode/session-adapter.ts";
import { ConsolidationScheduler } from "./scheduling/consolidation-scheduler.ts";
import { HeartbeatScheduler } from "./scheduling/heartbeat-scheduler.ts";
import type { StoreDb } from "./store/db.ts";
import { createDb, closeDb } from "./store/db.ts";
import { SqliteEventBuffer } from "./store/event-buffer.ts";
import { SqliteMcStatusProvider } from "./store/mc-status-provider.ts";
import { incrementEmoji } from "./store/queries.ts";

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

// ─── Helper Functions ───────────────────────────────────────────

async function loadChannelConfig(root: string): Promise<ChannelConfigLoader> {
	const overlayChannels = resolve(root, "data/context/channels.json");
	const baseChannels = resolve(root, "context/channels.json");
	const channelsJson = existsSync(overlayChannels)
		? await Bun.file(overlayChannels).json()
		: await Bun.file(baseChannels).json();
	return new ChannelConfigLoader(channelsJson as ChannelConfigData);
}

function createMetrics(logger: Logger) {
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
	collector.setGauge(METRIC.BOT_INFO, 1, { bot_name: "hua" });
	return { collector, server: new PrometheusServer(collector, logger) };
}

// ─── LTM Recording ─────────────────────────────────────────────

interface LtmResources {
	chatAdapter: FenghuangChatAdapter;
	recorder: FenghuangConversationRecorder;
	consolidationScheduler: ConsolidationScheduler;
}

function setupLtmRecording(
	config: ReturnType<typeof loadConfig>,
	logger: Logger,
	metricsCollector?: PrometheusCollector,
): LtmResources | undefined {
	const ltmPort = config.opencode.basePort - 2;
	const dataDir = resolve(config.dataDir, "fenghuang");

	try {
		const ltmSessionPort = new OpencodeSessionAdapter({
			port: ltmPort,
			mcpServers: {},
			builtinTools: OPENCODE_ALL_TOOLS_DISABLED,
		});
		const chatAdapter = new FenghuangChatAdapter(
			ltmSessionPort,
			config.ltm.providerId,
			config.ltm.modelId,
		);

		const ollama = new OllamaEmbeddingAdapter(config.ltm.ollamaBaseUrl, config.ltm.embeddingModel);
		const llm = new CompositeLLMAdapter(chatAdapter, ollama);
		const recorder = new FenghuangConversationRecorder(llm, dataDir);
		const consolidationScheduler = new ConsolidationScheduler(recorder, logger, metricsCollector);

		logger.info(`[bootstrap] LTM auto-recording enabled (port=${ltmPort})`);
		return { chatAdapter, recorder, consolidationScheduler };
	} catch (err) {
		logger.error("[bootstrap] LTM auto-recording init failed, continuing without LTM", err);
		return undefined;
	}
}

// ─── Event Handlers ─────────────────────────────────────────────

function setupEventHandlers(
	gateway: DiscordGateway,
	db: StoreDb,
	ltmResources: LtmResources | undefined,
	logger: Logger,
	metricsCollector: PrometheusCollector,
): void {
	gateway.onHomeChannelMessage((msg) => {
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "home" });
		bufferIncomingMessage(db, msg, logger);
		if (ltmResources) {
			recordLtmMessage(ltmResources.recorder, msg, logger);
		}
		return Promise.resolve();
	});

	gateway.onMessage((msg) => {
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			channel_type: "mention",
		});
		bufferIncomingMessage(db, msg, logger);
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

async function startCoreMcp(
	config: ReturnType<typeof loadConfig>,
	root: string,
	logger: Logger,
): Promise<Subprocess> {
	const coreEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		DISCORD_TOKEN: config.discordToken,
		CORE_MCP_PORT: String(config.coreMcpPort),
		LTM_OPENCODE_PORT: String(config.opencode.basePort - 2),
		LTM_PROVIDER_ID: config.ltm.providerId,
		LTM_MODEL_ID: config.ltm.modelId,
		OLLAMA_BASE_URL: config.ltm.ollamaBaseUrl,
		LTM_EMBEDDING_MODEL: config.ltm.embeddingModel,
		LTM_DATA_DIR: resolve(config.dataDir, "fenghuang"),
		DATA_DIR: resolve(root, "data"),
	};

	const coreProcess = spawn({
		cmd: ["bun", "run", resolve(root, "src/mcp/core-server.ts")],
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
		logger.warn("[bootstrap] Core MCP server health check timed out, but keeping process alive");
		return coreProcess;
	}

	logger.info(`[bootstrap] Core MCP server started (port=${config.coreMcpPort})`);
	return coreProcess;
}

async function startMinecraftMcp(
	config: ReturnType<typeof loadConfig>,
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
		MC_MCP_PORT: String(config.minecraft.mcpPort),
	};
	if (config.minecraft.version) mcEnv.MC_VERSION = config.minecraft.version;

	const mcProcess = spawn({
		cmd: ["bun", "run", resolve(root, "src/mcp/minecraft/server.ts")],
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
	const root = resolve(import.meta.dirname, "..");
	const logger = new ConsoleLogger();

	// Store
	const db = createDb(config.dataDir);
	const sessionStore = new SessionStore(db);

	// LTM
	const ltmFactReader = new FenghuangFactReader(resolve(config.dataDir, "fenghuang"));
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

	// Metrics
	const metrics = createMetrics(logger);
	metrics.server.start();

	// Channel config
	const channelConfig = await loadChannelConfig(root);

	// Discord Gateway
	const gateway = new DiscordGateway(config.discordToken, logger);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	// Core MCP + Minecraft MCP (start in parallel)
	const coreReady = startCoreMcp(config, root, logger);
	const mcReady = startMinecraftMcp(config, root, logger);

	// Guild agents
	const guildIds = channelConfig.getGuildIds();
	const agents = new Map<string, AgentRunner>();

	for (const [index, guildId] of guildIds.entries()) {
		const eventBuffer = new SqliteEventBuffer(db, guildId);
		const profile = createConversationProfile({
			providerId: config.opencode.providerId,
			modelId: config.opencode.modelId,
			mcpServers: mcpServerConfigs(),
		});
		const sessionPort = new OpencodeSessionAdapter({
			port: config.opencode.basePort + index,
			mcpServers: profile.mcpServers,
			builtinTools: profile.builtinTools,
		});
		const runner = new AgentRunner({
			profile,
			guildId,
			sessionStore,
			contextBuilder,
			logger,
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
		});
		agents.set(guildId, runner);
	}

	// LTM recording
	const ltmResources = setupLtmRecording(config, logger, metrics.collector);

	// Event handlers
	setupEventHandlers(gateway, db, ltmResources, logger, metrics.collector);

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

	// Heartbeat — mc-check リマインダーの自動有効化/無効化
	syncMcCheckReminder(resolve(root, HEARTBEAT_CONFIG_RELATIVE_PATH), !!config.minecraft, logger);
	const heartbeatScheduler = new HeartbeatScheduler(routingAgent, logger, metrics.collector, root);

	// Session gauge
	const sessionGaugeTimer = startSessionGauge(sessionStore, metrics.collector);

	// MCP processes
	const coreProcess = await coreReady;
	const mcProcess = await mcReady;

	// Minecraft sub-brain manager
	let mcSubBrainManager: McSubBrainManager | undefined;
	if (config.minecraft) {
		const mcProfile = createMinecraftProfile({
			providerId: config.mcSubBrain.providerId,
			modelId: config.mcSubBrain.modelId,
			mcpServers: mcpMinecraftSubBrainConfigs(),
		});
		mcSubBrainManager = new McSubBrainManager({
			db,
			sessionStore,
			logger,
			root,
			createSessionPort: () =>
				new OpencodeSessionAdapter({
					// ギルドエージェントが basePort + 0..N-1 を使うため、サブブレインは basePort + N を使用
					port: config.opencode.basePort + guildIds.length,
					mcpServers: mcProfile.mcpServers,
					builtinTools: mcProfile.builtinTools,
				}),
			providerId: config.mcSubBrain.providerId,
			modelId: config.mcSubBrain.modelId,
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
			await mcSubBrainManager?.stop();
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
	for (const [guildId, runner] of agents) {
		runner.startPollingLoop().catch((err) => {
			logger.error(`[bootstrap] polling loop for guild ${guildId} unexpectedly rejected`, err);
		});
	}

	if (mcSubBrainManager) {
		mcSubBrainManager.start();
	}
}
