/* oxlint-disable max-dependencies, max-lines -- bootstrap file naturally requires many imports and lines for DI wiring */
import { dirname, resolve } from "path";

import type { DiscordAgent } from "@vicissitude/agent/discord/discord-agent";
import { formatDiscordMessage } from "@vicissitude/agent/discord/message-formatter";
import { GuildRouter } from "@vicissitude/agent/discord/router";
import { McBrainManager } from "@vicissitude/agent/minecraft/brain-manager";
import { WEB_AGENT_ID } from "@vicissitude/agent/web/web-agent";
import { fetchNewEmails, formatEmailContext } from "@vicissitude/application/email-fetcher";
import { HeartbeatService } from "@vicissitude/application/heartbeat-service";
import { MessageIngestionService } from "@vicissitude/application/message-ingestion-service";
import { ResumeContextService } from "@vicissitude/application/resume-context-service";
import { createEmotionToExpressionMapper } from "@vicissitude/avatar";
import { createGatewayApp, listenGatewayServer } from "@vicissitude/gateway/server";
import { WsConnectionManager } from "@vicissitude/gateway/ws-handler";
import { MemoryFactReaderImpl } from "@vicissitude/memory/fact-reader";
import { discordDmUserIdFromScopeId, discordScopeId } from "@vicissitude/memory/namespace";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { METRIC, type PrometheusCollector } from "@vicissitude/observability/metrics";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";
import { HEARTBEAT_CONFIG_RELATIVE_PATH } from "@vicissitude/scheduling/heartbeat-helpers";
import { HeartbeatScheduler } from "@vicissitude/scheduling/heartbeat-scheduler";
import type { PreFilterResult } from "@vicissitude/scheduling/heartbeat-scheduler";
import type { AiAgent, DueReminder, Logger, SessionStorePort } from "@vicissitude/shared/types";
import { closeDb } from "@vicissitude/store/db";
import { SqliteMoodStore } from "@vicissitude/store/mood-store";
import { incrementEmoji } from "@vicissitude/store/queries";
import { AivisSpeechSynthesizer, createEmotionToTtsStyleMapper } from "@vicissitude/tts";
import { spawn, type Subprocess } from "bun";

import {
	createConversationAgentSpecs,
	createDiscordAgents,
	createHeartbeatAgentSpecs,
	createWebConversationAgent,
} from "./bootstrap/agents.ts";
import { loadChannelConfig } from "./bootstrap/channel-config.ts";
import { buildCoreEnvironment, buildDiscordEnvironment } from "./bootstrap/environment.ts";
import {
	createContextLayer,
	createFileSessionSummaryWriter,
	createStoreLayer,
	createWebContextLayer,
} from "./bootstrap/layers.ts";
import { setupMemoryRecording } from "./bootstrap/memory-recording.ts";
import { createMetrics } from "./bootstrap/metrics.ts";
import { type AppConfig, loadConfig } from "./config.ts";
import { DiscordGateway } from "./gateway/discord.ts";
import {
	migrateMemoryDir,
	removeLegacyConsolidateReminder,
	syncEmailCheckReminder,
	syncMcCheckReminder,
} from "./migrations.ts";
import { MoodNicknameService } from "./mood-nickname.ts";
import { createPortLayout } from "./port-allocator.ts";
import { createShutdown } from "./shutdown.ts";

// ─── Event Handlers ─────────────────────────────────────────────

function setupEventHandlers(deps: {
	gateway: DiscordGateway;
	ingestionService: MessageIngestionService;
	metricsCollector: PrometheusCollector;
	agents: Map<string, DiscordAgent>;
	logger: Logger;
	/** 信頼ユーザー (依頼者) 集合。これに含まれる authorId のメッセージに信頼マーカーを付ける */
	trustedUserIds: string[];
}): void {
	const { gateway, ingestionService, metricsCollector, agents, logger, trustedUserIds } = deps;
	gateway.onResume(() => {
		logger.info(`[bootstrap] Discord Gateway resumed; ensuring ${agents.size} conversation loops`);
		for (const agent of agents.values()) agent.ensurePolling();
	});
	gateway.onHomeChannelMessage(async (msg) => {
		const selfUserId = gateway.getClient()?.user?.id;
		const scopeId = msg.scopeId ?? (msg.guildId ? discordScopeId(msg.guildId) : undefined);
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			guild_id: msg.guildId ?? "none",
			channel_type: "home",
			author_type: msg.isBot ? "bot" : "user",
			is_thread: String(msg.isThread),
			has_attachments: String(msg.attachments.length > 0),
		});
		await ingestionService.handleIncomingMessage(msg, {
			recordConversation: true,
		});
		if (msg.guildId && msg.authorId !== selfUserId) {
			const agent = scopeId ? agents.get(scopeId) : undefined;
			if (!agent) {
				logger.warn(`[bootstrap] no agent for guild ${msg.guildId}, message will not be processed`);
			}
			void agent?.send({
				sessionKey: "home",
				message: formatDiscordMessage(msg, { trustedUserIds }),
				scopeId,
				attachments: msg.attachments,
				channelId: msg.channelId,
				isBot: msg.isBot,
			});
		}
	});

	gateway.onMessage(async (msg) => {
		const scopeId = msg.scopeId ?? (msg.guildId ? discordScopeId(msg.guildId) : undefined);
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			guild_id: msg.guildId ?? "none",
			channel_type: "mention",
			author_type: msg.isBot ? "bot" : "user",
			is_thread: String(msg.isThread),
			has_attachments: String(msg.attachments.length > 0),
		});
		await ingestionService.handleIncomingMessage(msg);
		if (msg.guildId && scopeId) {
			const agent = agents.get(scopeId);
			if (!agent) {
				logger.warn(`[bootstrap] no agent for guild ${msg.guildId}, mention will not be processed`);
			}
			void agent?.send({
				sessionKey: "mention",
				message: formatDiscordMessage(msg, { trustedUserIds }),
				scopeId,
				attachments: msg.attachments,
				channelId: msg.channelId,
				isBot: msg.isBot,
			});
		}
	});

	gateway.onDirectMessage(async (msg) => {
		const selfUserId = gateway.getClient()?.user?.id;
		const scopeId = msg.scopeId;
		metricsCollector.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, {
			guild_id: "none",
			channel_type: "dm",
			author_type: msg.isBot ? "bot" : "user",
			is_thread: String(msg.isThread),
			has_attachments: String(msg.attachments.length > 0),
		});
		await ingestionService.handleIncomingMessage(msg, {
			recordConversation: true,
		});
		if (!scopeId) {
			logger.warn("[bootstrap] DM message has no scopeId, message will not be processed");
			return;
		}
		if (msg.authorId === selfUserId) return;

		const agent = agents.get(scopeId);
		if (!agent) {
			const userId = discordDmUserIdFromScopeId(scopeId) ?? "unknown";
			logger.warn(`[bootstrap] no DM agent for user ${userId}, message will not be processed`);
		}
		void agent?.send({
			sessionKey: "dm",
			message: formatDiscordMessage(msg, { trustedUserIds }),
			scopeId,
			attachments: msg.attachments,
			channelId: msg.channelId,
			isBot: msg.isBot,
		});
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
		cmd: ["bun", "run", resolve(root, "packages/minecraft/src/server.ts")],
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
	sessionStore: SessionStorePort,
	metricsCollector: PrometheusCollector,
): ReturnType<typeof setInterval> {
	const update = () => metricsCollector.setGauge(METRIC.LLM_ACTIVE_SESSIONS, sessionStore.count());
	update();
	return setInterval(update, 30_000);
}

export function resolveBootstrapRoot(
	config: Pick<AppConfig, "contextDir">,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return env.APP_ROOT ?? dirname(config.contextDir);
}

// ─── Email Check PreFilter ──────────────────────────────────────

export function buildEmailCheckPreFilter(
	logger: Logger,
	emailConfig?: AppConfig["emailCheck"],
): ((dueReminders: DueReminder[]) => Promise<PreFilterResult>) | undefined {
	if (!emailConfig) return undefined;
	const { endpoint, token } = emailConfig;

	return async (dueReminders: DueReminder[]): Promise<PreFilterResult> => {
		const emailReminders = dueReminders.filter((d) => d.reminder.id === "email-check");
		const otherReminders = dueReminders.filter((d) => d.reminder.id !== "email-check");

		if (emailReminders.length === 0) return { reminders: dueReminders };

		try {
			const result = await fetchNewEmails(endpoint, token);
			if (!result.hasNewMail) {
				return { reminders: otherReminders, markExecutedIds: ["email-check"] };
			}
			const context = formatEmailContext(result);
			const enriched = emailReminders.map((d) => Object.assign({}, d, { context }));
			return { reminders: [...otherReminders, ...enriched] };
		} catch (error) {
			logger.error("[heartbeat] email check failed:", error);
			return { reminders: otherReminders, markExecutedIds: ["email-check"] };
		}
	};
}

// ─── Main Bootstrap ─────────────────────────────────────────────

export async function bootstrap(): Promise<void> {
	const config = loadConfig();
	const root = resolveBootstrapRoot(config);
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
	const { contextBuilder: webContextBuilder } = createWebContextLayer(config, root, factReader);

	// Metrics
	const metricsPort = Number(process.env.METRICS_PORT) || 9091;
	const metrics = createMetrics(logger, metricsPort);
	metrics.server.start();

	// Channel config
	const channelConfig = await loadChannelConfig(root);
	const guildIds = channelConfig.getGuildIds();
	const dmUserIds = config.discordDm?.allowedUserIds ?? [];
	const ports = createPortLayout(
		config.opencode.basePort,
		guildIds.length + dmUserIds.length,
		guildIds.length,
	);

	// MCP environments (stdio プロセスに渡す環境変数)
	const coreEnvironment = buildCoreEnvironment(config, root);
	const discordEnvironment = buildDiscordEnvironment(config, root);

	// Discord Gateway
	const gateway = new DiscordGateway(config.discordToken, logger);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());
	gateway.setAllowedDirectMessageUserIds(dmUserIds);

	// Minecraft MCP (HTTP, start async)
	const mcReady = startMinecraftMcp(config, root, logger);

	// Memory recording
	const memoryResources = await setupMemoryRecording(config, logger, {
		memoryPort: ports.memory(),
		metricsCollector: metrics.collector,
		embeddingAdapter: ollamaEmbedding,
		root,
		// gateway.start() より前に setupMemoryRecording が呼ばれるため、
		// CriticAuditor が必要とする bot user id は遅延解決する (#847)
		getBotUserId: () => gateway.getClient()?.user?.id,
	});

	const webAgent = createWebConversationAgent(config, {
		sessionStore,
		contextBuilder: webContextBuilder,
		logger,
		recorder: memoryResources?.recorder,
		appRoot: root,
		coreEnvironment,
		opencodePort: ports.webAgent(),
	});

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
	const emotionToExpressionMapper = createEmotionToExpressionMapper();
	const wsManager = new WsConnectionManager({
		emotionToExpressionMapper,
		chatResponder: webAgent,
		ttsSynthesizer,
		ttsStyleMapper,
		moodReader: moodStore,
		moodAgentId: WEB_AGENT_ID,
		logger,
	});
	const gatewayApp = createGatewayApp(wsManager);
	const gatewayServer = listenGatewayServer(gatewayApp, config.gatewayPort);
	logger.info(
		`[bootstrap] Gateway server started (port=${config.gatewayPort}, tts=${!!config.tts})`,
	);

	// Guild agents
	const contextOverlayDir = resolve(root, "data/context");
	const resumeContextService = new ResumeContextService({
		memoryDataDir,
		overlayDir: contextOverlayDir,
		logger,
	});
	await resumeContextService.updateGuilds(guildIds);
	const summaryWriter = createFileSessionSummaryWriter(contextOverlayDir, (guildId) =>
		resumeContextService.updateGuild(guildId),
	);
	const conversationAgentSpecs = createConversationAgentSpecs(guildIds, dmUserIds);
	const agents = createDiscordAgents(config, conversationAgentSpecs, {
		db,
		sessionStore,
		contextBuilder,
		logger,
		metrics: metrics.collector,
		summaryWriter,
		appRoot: root,
		coreEnvironment,
		discordEnvironment,
		compactionTokenThreshold: 20_000,
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
		trustedUserIds: dmUserIds,
	});

	// Emoji tracking
	gateway.onEmojiUsed((guildId, emojiName) => incrementEmoji(db, guildId, emojiName));

	// Routing agent (ユーザーメッセージ用)
	const firstAgent = agents.values().next().value as AiAgent | undefined;
	if (!firstAgent) {
		throw new Error("No guild agents available; cannot create defaultAgent for GuildRouter");
	}
	const routingAgent = new GuildRouter(agents, firstAgent);

	// Heartbeat 専用エージェント（ユーザーメッセージとセッションを分離し、遅延を防ぐ）
	const heartbeatAgentSpecs = createHeartbeatAgentSpecs(guildIds);
	const heartbeatAgents = createDiscordAgents(config, heartbeatAgentSpecs, {
		db,
		sessionStore,
		contextBuilder,
		logger,
		metrics: metrics.collector,
		portOffset: ports.heartbeatOffset,
		appRoot: root,
		coreEnvironment,
		discordEnvironment,
		compactionTokenThreshold: 20_000,
		opencode: config.heartbeatOpencode,
	});
	const firstHeartbeatAgent = heartbeatAgents.values().next().value as AiAgent | undefined;
	if (!firstHeartbeatAgent) {
		throw new Error(
			"No heartbeat agents available; cannot create defaultAgent for heartbeat GuildRouter",
		);
	}
	const heartbeatRouter = new GuildRouter(heartbeatAgents, firstHeartbeatAgent);

	// Heartbeat — リマインダー同期
	const heartbeatConfigPath = resolve(root, HEARTBEAT_CONFIG_RELATIVE_PATH);
	syncMcCheckReminder(heartbeatConfigPath, !!config.minecraft, logger);
	syncEmailCheckReminder(heartbeatConfigPath, !!config.emailCheck, logger);
	removeLegacyConsolidateReminder(heartbeatConfigPath, logger);
	const heartbeatScheduler = new HeartbeatScheduler({
		configRepo: new JsonHeartbeatConfigRepository(heartbeatConfigPath),
		heartbeatService: new HeartbeatService({ agent: heartbeatRouter, logger }),
		logger,
		metrics: metrics.collector,
		preFilter: buildEmailCheckPreFilter(logger, config.emailCheck),
	});

	// Session gauge
	const sessionGaugeTimer = startSessionGauge(sessionStore, metrics.collector);
	const moodNickname = new MoodNicknameService(gateway, moodStore, logger, guildIds);

	// MCP processes (Minecraft のみ HTTP、core は stdio で OpenCode が管理)
	const mcProcess = await mcReady;

	// Minecraft brain manager
	let mcBrainManager: McBrainManager | undefined;
	if (config.minecraft) {
		// minecraft と mcBrain は同時に存在/不在 (profile に models.minecraft がある時のみ両方生成される)
		if (!config.mcBrain) {
			throw new Error("config.mcBrain is required when config.minecraft is set");
		}
		mcBrainManager = new McBrainManager({
			db,
			sessionStore,
			logger,
			root,
			opencodePort: ports.minecraft(),
			providerId: config.mcBrain.providerId,
			modelId: config.mcBrain.modelId,
			temperature: config.mcBrain.temperature,
			sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
			mcHost: config.minecraft.host,
			mcMcpPort: String(config.minecraft.mcpPort),
			compactionTokenThreshold: 20_000,
			metrics: metrics.collector,
		});
	}

	// Graceful shutdown
	const shutdown = createShutdown({
		logger,
		sessionGaugeTimer,
		moodNickname,
		consolidationScheduler: memoryResources?.consolidationScheduler,
		heartbeatScheduler,
		gateway,
		gatewayServer,
		webAgent,
		mcBrainManager,
		heartbeatRouter,
		routingAgent,
		metricsServer: metrics.server,
		factReader,
		chatAdapter: memoryResources?.chatAdapter,
		recorder: memoryResources?.recorder,
		mcProcess,
		resumeContextService,
		closeDb: () => closeDb(db),
	});
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	// Start
	logger.info(
		`[bootstrap] Polling mode for ${guildIds.length} guild(s), ${dmUserIds.length} DM user(s): ${guildIds.join(", ")}`,
	);
	await gateway.start();
	moodNickname.start();
	heartbeatScheduler.start();
	memoryResources?.consolidationScheduler.start();
	// DiscordAgent は lazy start: 最初の send() 呼び出しで自動的にポーリングループが起動する
	mcBrainManager?.start();
}
