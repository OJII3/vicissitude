/* oxlint-disable max-dependencies, max-classes-per-file, max-lines -- bootstrap file naturally requires many imports, classes, and lines for DI wiring */
import { existsSync } from "fs";
import { resolve } from "path";

import { spawn, type Subprocess } from "bun";

import { ContextBuilder } from "./agent/context-builder.ts";
import { createConversationProfile } from "./agent/profiles/conversation.ts";
import { GuildRouter, type AiAgent } from "./agent/router.ts";
import { AgentRunner, type EventBuffer } from "./agent/runner.ts";
import { SessionStore } from "./agent/session-store.ts";
import { loadConfig } from "./core/config.ts";
import type { BufferedEvent, ConversationMessage, IncomingMessage, Logger } from "./core/types.ts";
import { DiscordGateway } from "./gateway/discord.ts";
import { HeartbeatScheduler, ConsolidationScheduler } from "./gateway/scheduler.ts";
import { CompositeLLMAdapter } from "./infrastructure/fenghuang/composite-llm-adapter.ts";
import { FenghuangChatAdapter } from "./infrastructure/fenghuang/fenghuang-chat-adapter.ts";
import { FenghuangConversationRecorder } from "./infrastructure/fenghuang/fenghuang-conversation-recorder.ts";
// infrastructure imports that will be cleaned up in M11:
import { FenghuangFactReader } from "./infrastructure/fenghuang/fenghuang-fact-reader.ts";
import { OllamaEmbeddingAdapter } from "./infrastructure/ollama/ollama-embedding-adapter.ts";
import { mcpServerConfigs } from "./infrastructure/opencode/mcp-config.ts";
import { ConsoleLogger } from "./observability/logger.ts";
import {
	PrometheusCollector,
	PrometheusServer,
	METRIC,
	InstrumentedAiAgent,
} from "./observability/metrics.ts";
import { createDb, type StoreDb } from "./store/db.ts";
import { appendEvent, hasEvents, incrementEmoji } from "./store/queries.ts";

// ─── Channel Config Loader ──────────────────────────────────────

interface ChannelConfigData {
	defaultCooldownSeconds: number;
	channels: Array<{
		channelId: string;
		guildId: string;
		guildName?: string;
		channelName?: string;
		role: "home" | "default";
		cooldownSeconds?: number;
	}>;
}

class ChannelConfigLoader {
	private readonly configs: Map<string, { guildId: string; role: "home" | "default" }>;

	constructor(json: ChannelConfigData) {
		this.configs = new Map();
		for (const ch of json.channels) {
			this.configs.set(ch.channelId, { guildId: ch.guildId, role: ch.role });
		}
	}

	getGuildIds(): string[] {
		const guildIds = new Set<string>();
		for (const config of this.configs.values()) {
			guildIds.add(config.guildId);
		}
		return [...guildIds];
	}

	getHomeChannelIds(): string[] {
		const ids: string[] = [];
		for (const [id, config] of this.configs) {
			if (config.role === "home") ids.push(id);
		}
		return ids;
	}
}

// ─── SQLite Event Buffer ────────────────────────────────────────

class SqliteEventBuffer implements EventBuffer {
	constructor(
		private readonly db: StoreDb,
		private readonly guildId: string,
	) {}

	async append(event: BufferedEvent): Promise<void> {
		appendEvent(this.db, this.guildId, JSON.stringify(event));
		await Promise.resolve();
	}

	waitForEvents(signal: AbortSignal): Promise<void> {
		// oxlint-disable-next-line no-shadow -- Promise parameter shadows `resolve` import, intentional
		return new Promise((resolve) => {
			const poll = () => {
				if (signal.aborted) {
					resolve();
					return;
				}
				if (hasEvents(this.db, this.guildId)) {
					resolve();
					return;
				}
				setTimeout(poll, 1000);
			};
			signal.addEventListener("abort", () => resolve(), { once: true });
			poll();
		});
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

async function setupLtmRecording(
	config: ReturnType<typeof loadConfig>,
	logger: Logger,
	metricsCollector?: PrometheusCollector,
): Promise<LtmResources | undefined> {
	const ltmPort = config.opencode.basePort - 2;
	const dataDir = resolve(config.dataDir, "fenghuang");

	try {
		const chatAdapter = new FenghuangChatAdapter(
			ltmPort,
			config.ltm.providerId,
			config.ltm.modelId,
		);
		await chatAdapter.initialize();

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

// ─── LTM Message Recording (inline) ────────────────────────────

function recordLtmMessage(
	recorder: FenghuangConversationRecorder,
	msg: IncomingMessage,
	logger: Logger,
): void {
	if (!msg.guildId) return;
	if (!msg.content && msg.attachments.length === 0) return;

	const role = msg.isBot ? "assistant" : "user";
	let content = msg.content;
	if (msg.attachments.length > 0) {
		const info = msg.attachments.map((a) => `[添付: ${a.filename ?? "unknown"}]`).join(" ");
		content = content ? `${content} ${info}` : info;
	}

	const message: ConversationMessage = {
		role,
		content,
		name: msg.authorName,
		timestamp: msg.timestamp,
	};

	recorder.record(msg.guildId, message).catch((err) => {
		logger.error("[ltm-record] failed to record message", err);
	});
}

// ─── Event Handlers ─────────────────────────────────────────────

function bufferIncomingMessage(db: StoreDb, msg: IncomingMessage, logger: Logger): void {
	if (!msg.content && msg.attachments.length === 0) return;
	if (!msg.guildId) {
		logger.warn(`[bootstrap] No guildId for message, dropping event`);
		return;
	}

	const event: BufferedEvent = {
		ts: msg.timestamp.toISOString(),
		channelId: msg.channelId,
		guildId: msg.guildId,
		authorId: msg.authorId,
		authorName: msg.authorName,
		messageId: msg.messageId,
		content: msg.content,
		attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
		isBot: msg.isBot,
		isMentioned: msg.isMentioned,
		isThread: msg.isThread,
	};

	appendEvent(db, msg.guildId, JSON.stringify(event));
	logger.info(
		`[buffer-event] buffered: ch=${msg.channelId} author=${msg.authorName} mentioned=${msg.isMentioned}`,
	);
}

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

// ─── Minecraft MCP ──────────────────────────────────────────────

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
			fetch(`http://localhost:${port}/mcp`, { method: "GET" })
				.then((res) => res.status)
				.catch(() => null),
			exitPromise,
		]);
		if (result === processDied) return "died";
		if (result !== null) return "ready";
		await Bun.sleep(500);
	}
	/* oxlint-enable no-await-in-loop */
	return "timeout";
}

async function startMinecraftMcp(
	config: ReturnType<typeof loadConfig>,
	root: string,
	logger: Logger,
): Promise<Subprocess | null> {
	if (!config.minecraft) return null;

	const mcEnv: Record<string, string> = {
		...(process.env as Record<string, string>),
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
		logger.error("[bootstrap] Minecraft MCP server failed to start within timeout");
	} else {
		logger.info("[bootstrap] Minecraft MCP server started");
	}

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
	const contextBuilder = new ContextBuilder(
		resolve(root, "data/context"),
		resolve(root, "context"),
		ltmFactReader,
	);

	// Metrics
	const metrics = createMetrics(logger);
	metrics.server.start();

	// Channel config
	const channelConfig = await loadChannelConfig(root);

	// Discord Gateway
	const gateway = new DiscordGateway(config.discordToken, logger);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	// Minecraft MCP (start in parallel)
	const mcReady = startMinecraftMcp(config, root, logger);

	// Guild agents
	const guildIds = channelConfig.getGuildIds();
	const agents = new Map<string, AgentRunner>();

	for (const [index, guildId] of guildIds.entries()) {
		const eventBuffer = new SqliteEventBuffer(db, guildId);
		const profile = createConversationProfile({
			providerId: config.opencode.providerId,
			modelId: config.opencode.modelId,
			mcpServers: mcpServerConfigs({ includeEventBuffer: true, guildId }),
		});
		const runner = new AgentRunner({
			profile,
			guildId,
			sessionStore,
			contextBuilder,
			logger,
			port: config.opencode.basePort + index,
			eventBuffer,
		});
		agents.set(guildId, runner);
	}

	// LTM recording
	const ltmResources = await setupLtmRecording(config, logger, metrics.collector);

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

	// Heartbeat
	const heartbeatScheduler = new HeartbeatScheduler(routingAgent, logger, metrics.collector, root);

	// Session gauge
	const sessionGaugeTimer = startSessionGauge(sessionStore, metrics.collector);

	// Minecraft MCP
	const mcProcess = await mcReady;

	// Graceful shutdown
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down...");
		clearInterval(sessionGaugeTimer);
		ltmResources?.consolidationScheduler.stop();
		heartbeatScheduler.stop();
		gateway.stop();
		routingAgent.stop();
		metrics.server.stop();
		ltmResources?.chatAdapter.close();
		ltmResources?.recorder.close();
		void ltmFactReader.close();
		mcProcess?.kill();
		setTimeout(() => process.exit(0), 1000);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

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
}
