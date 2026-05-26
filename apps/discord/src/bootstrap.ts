/* oxlint-disable max-dependencies, max-lines -- bootstrap file naturally requires many imports and lines for DI wiring */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

import { ContextBuilder, type ContextFileName } from "@vicissitude/agent/discord/context-builder";
import { DiscordAgent } from "@vicissitude/agent/discord/discord-agent";
import { ImageAttachmentDescriber } from "@vicissitude/agent/discord/image-attachment-describer";
import { formatDiscordMessage } from "@vicissitude/agent/discord/message-formatter";
import { createConversationProfile } from "@vicissitude/agent/discord/profile";
import { GuildRouter } from "@vicissitude/agent/discord/router";
import { mcpServerConfigs } from "@vicissitude/agent/mcp-config";
import { McBrainManager } from "@vicissitude/agent/minecraft/brain-manager";
import { SessionStore } from "@vicissitude/agent/session-store";
import { createWebConversationProfile } from "@vicissitude/agent/web/profile";
import { WEB_AGENT_ID, WEB_SCOPE_ID, WebConversationAgent } from "@vicissitude/agent/web/web-agent";
import { HeartbeatService } from "@vicissitude/application/heartbeat-service";
import { MessageIngestionService } from "@vicissitude/application/message-ingestion-service";
import { ResumeContextService } from "@vicissitude/application/resume-context-service";
import { createEmotionToExpressionMapper } from "@vicissitude/avatar";
import { createGatewayApp, listenGatewayServer } from "@vicissitude/gateway/server";
import { WsConnectionManager } from "@vicissitude/gateway/ws-handler";
import { GitHubIssueAdapter } from "@vicissitude/infrastructure/http/github-issue-adapter";
import { MemoryChatAdapter } from "@vicissitude/memory/chat-adapter";
import { CompositeLLMAdapter } from "@vicissitude/memory/composite-llm-adapter";
import { MemoryConversationRecorder } from "@vicissitude/memory/conversation-recorder";
import { CriticAuditor } from "@vicissitude/memory/critic-auditor";
import { DriftScoreCalculator } from "@vicissitude/memory/drift-score";
import { MemoryFactReaderImpl } from "@vicissitude/memory/fact-reader";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
	agentScopeNamespace,
	discordDmScopeId,
	discordDmUserIdFromScopeId,
	discordGuildIdFromScopeId,
	discordScopeId,
	HUA_SELF_SUBJECT,
	INTERNAL_NAMESPACE,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
} from "@vicissitude/memory/namespace";
import { MemoryStorage } from "@vicissitude/memory/storage";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import { PrometheusCollector, PrometheusServer, METRIC } from "@vicissitude/observability/metrics";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import {
	denyAllSkillPermission,
	OPENCODE_ALL_TOOLS_DISABLED,
} from "@vicissitude/opencode/constants";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";
import { HEARTBEAT_CONFIG_RELATIVE_PATH } from "@vicissitude/scheduling/heartbeat-helpers";
import { HeartbeatScheduler } from "@vicissitude/scheduling/heartbeat-scheduler";
import { addGitHubCredentialHelperEnvironment } from "@vicissitude/shared/github-auth-env";
import type { MemoryNamespace } from "@vicissitude/shared/namespace";
import type { CriticAuditorPort } from "@vicissitude/shared/ports";
import type {
	AiAgent,
	ConversationRecorder,
	ContextBuilderPort,
	Logger,
	MemoryFactReader,
	MetricsCollector,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";
import {
	workspaceGitConfigPath,
	writeShellWorkspaceGitConfig,
} from "@vicissitude/shared/workspace-gitconfig";
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

export function createContextLayer(
	_config: AppConfig,
	root: string,
	factReader?: MemoryFactReader,
) {
	const contextBuilder = new ContextBuilder(
		resolve(root, "data/context"),
		resolve(root, "context"),
		factReader,
	);
	return { contextBuilder };
}

export function createWebContextLayer(
	config: AppConfig,
	root: string,
	factReader?: MemoryFactReader,
) {
	const excludeFiles = new Set<ContextFileName>(["DISCORD.md", "HEARTBEAT.md", "TOOLS-DISCORD.md"]);
	const contextBuilder = new ContextBuilder(
		resolve(root, "data/context"),
		resolve(root, "context"),
		factReader,
		excludeFiles,
	);
	return { contextBuilder };
}

// ─── Guild Agents ───────────────────────────────────────────────

function createFileSessionSummaryWriter(
	overlayDir: string,
	onWrite?: (guildId: string) => Promise<void>,
): SessionSummaryWriter {
	return {
		async write(scopeId: string, content: string): Promise<void> {
			const guildId = discordGuildIdFromScopeId(scopeId);
			const dir = guildId
				? resolve(overlayDir, `guilds/${guildId}`)
				: resolve(overlayDir, `scopes/${encodeURIComponent(scopeId)}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(resolve(dir, "SESSION-SUMMARY.md"), content);
			if (guildId) await onWrite?.(guildId);
		},
	};
}

/** core MCP stdio プロセスに渡す環境変数を組み立てる */
export function buildCoreEnvironment(config: AppConfig, root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		OLLAMA_BASE_URL: config.memory.ollamaBaseUrl,
		MEMORY_OLLAMA_BASE_URL: config.memory.ollamaBaseUrl,
		MEMORY_EMBEDDING_MODEL: config.memory.embeddingModel,
		MEMORY_DATA_DIR: resolve(config.dataDir, "memory"),
		DATA_DIR: resolve(root, "data"),
	};
}

/** Discord MCP stdio プロセスに渡す環境変数を組み立てる */
export function buildDiscordEnvironment(config: AppConfig, root: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		DISCORD_TOKEN: config.discordToken,
		DATA_DIR: resolve(root, "data"),
	};

	if (config.emotionEstimation) {
		env.EMOTION_ESTIMATION_ENABLED = "true";
		env.EMOTION_PROVIDER_ID = config.emotionEstimation.providerId;
		env.EMOTION_MODEL_ID = config.emotionEstimation.modelId;
		if (config.emotionEstimation.ollamaBaseUrl) {
			env.EMOTION_OLLAMA_BASE_URL = config.emotionEstimation.ollamaBaseUrl;
		}
	}

	if (config.minecraft) {
		env.MC_HOST = config.minecraft.host;
	}

	if (config.shellWorkspace) {
		env.DISCORD_ATTACHMENT_ALLOWED_DIRS = config.shellWorkspace.dataDir;
	}

	return env;
}

function prepareOpencodeShellWorkspaceDirectory(
	config: AppConfig,
	agentId: string,
): string | undefined {
	if (!config.shellWorkspace) return;
	const safeAgentId = agentId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
	const directory = resolve(config.shellWorkspace.dataDir, "opencode", safeAgentId);
	if (config.shellWorkspace.git) writeShellWorkspaceGitConfig(directory, config.shellWorkspace.git);
	return directory;
}

function buildOpencodeShellWorkspaceEnvironment(
	config: AppConfig,
	directory: string | undefined,
): Record<string, string> | undefined {
	if (!config.shellWorkspace) return;
	const environment = config.shellWorkspace.environment
		? { ...config.shellWorkspace.environment }
		: {};
	const baseEnvironment: Record<string, string> = { ...environment };
	if (config.shellWorkspace.git && directory) {
		baseEnvironment.GIT_CONFIG_GLOBAL = workspaceGitConfigPath(directory);
	}
	if (!config.shellWorkspace.backgroundSubagents)
		return addGitHubCredentialHelperEnvironment(baseEnvironment);
	return addGitHubCredentialHelperEnvironment({
		...baseEnvironment,
		OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
	});
}

const EMOTION_OPENCODE_PORT_OFFSET = 1000;

function opencodeSkillPaths(appRoot: string): string[] {
	return [resolve(appRoot, ".agents/skills")];
}

export function buildAgentDiscordEnvironment(
	config: AppConfig,
	baseEnvironment: Record<string, string>,
	agentPort: number,
): Record<string, string> {
	if (!config.emotionEstimation || config.emotionEstimation.providerId === "ollama") {
		return baseEnvironment;
	}
	return {
		...baseEnvironment,
		EMOTION_OPENCODE_PORT: String(agentPort + EMOTION_OPENCODE_PORT_OFFSET),
	};
}

export interface DiscordAgentSpec {
	agentId: string;
	scopeId: string;
}

export function createConversationAgentSpecs(
	guildIds: string[],
	dmUserIds: string[],
): DiscordAgentSpec[] {
	return [
		...guildIds.map((guildId) => ({
			agentId: `discord:${guildId}`,
			scopeId: discordScopeId(guildId),
		})),
		...dmUserIds.map((userId) => ({
			agentId: `discord:dm:${userId}`,
			scopeId: discordDmScopeId(userId),
		})),
	];
}

export function createHeartbeatAgentSpecs(guildIds: string[]): DiscordAgentSpec[] {
	return guildIds.map((guildId) => ({
		agentId: `discord:heartbeat:${guildId}`,
		scopeId: discordScopeId(guildId),
	}));
}

function isHeartbeatAgentId(agentId: string): boolean {
	return agentId.startsWith("discord:heartbeat:");
}

function canUseShellWorkspace(config: AppConfig, agentId: string): boolean {
	return !!config.shellWorkspace && !isHeartbeatAgentId(agentId);
}

export function createDiscordAgents(
	config: AppConfig,
	agentSpecs: DiscordAgentSpec[],
	deps: {
		db: StoreDb;
		sessionStore: SessionStorePort;
		contextBuilder: ContextBuilderPort;
		logger: Logger;
		metrics?: MetricsCollector;
		summaryWriter?: SessionSummaryWriter;
		/** ポート番号のオフセット（デフォルト: 0）。basePort + portOffset + index でポートを決定 */
		portOffset?: number;
		appRoot: string;
		coreEnvironment: Record<string, string>;
		discordEnvironment: Record<string, string>;
		/** proactive compaction のトークン閾値。省略時は proactive compaction 無効 */
		compactionTokenThreshold?: number;
		/** compaction 間のクールダウン（ms） */
		compactionCooldownMs?: number;
		/** この agent 群が使う OpenCode モデル設定。省略時は通常会話設定を使う */
		opencode?: Pick<AppConfig["opencode"], "providerId" | "modelId" | "temperature">;
	},
): Map<string, DiscordAgent> {
	const agents = new Map<string, DiscordAgent>();
	const portOffset = deps.portOffset ?? 0;
	const opencode = deps.opencode ?? config.opencode;

	for (const [index, spec] of agentSpecs.entries()) {
		const agentPort = config.opencode.basePort + portOffset + index;
		const shellWorkspaceEnabled = canUseShellWorkspace(config, spec.agentId);
		const shellWorkspaceDirectory = shellWorkspaceEnabled
			? prepareOpencodeShellWorkspaceDirectory(config, spec.agentId)
			: undefined;
		const profile = createConversationProfile({
			providerId: opencode.providerId,
			modelId: opencode.modelId,
			mcpServers: mcpServerConfigs(spec.agentId, {
				appRoot: deps.appRoot,
				coreEnvironment: deps.coreEnvironment,
				discord: {
					environment: buildAgentDiscordEnvironment(config, deps.discordEnvironment, agentPort),
				},
			}),
			minecraftEnabled: !!config.minecraft,
			imageRecognitionEnabled: !!config.imageRecognition,
			shellWorkspaceSubagent: shellWorkspaceEnabled ? config.shellWorkspace?.agent : undefined,
			shellWorkspaceBackgroundSubagents: shellWorkspaceEnabled
				? config.shellWorkspace?.backgroundSubagents
				: undefined,
		});
		const sessionPort = new OpencodeSessionAdapter({
			port: agentPort,
			mcpServers: profile.mcpServers,
			builtinTools: profile.builtinTools,
			skillPermission: profile.skillPermission,
			skillPaths: opencodeSkillPaths(deps.appRoot),
			agents: profile.opencodeAgents,
			defaultAgent: profile.defaultAgent,
			primaryTools: profile.primaryTools,
			temperature: opencode.temperature,
			directory: shellWorkspaceDirectory,
			environment: shellWorkspaceEnabled
				? buildOpencodeShellWorkspaceEnvironment(config, shellWorkspaceDirectory)
				: undefined,
			logger: deps.logger,
		});
		const attachmentProcessor = config.imageRecognition
			? new ImageAttachmentDescriber({
					sessionPort,
					model: {
						providerId: config.imageRecognition.providerId,
						modelId: config.imageRecognition.modelId,
					},
					logger: deps.logger,
				})
			: undefined;
		const agent = new DiscordAgent({
			agentId: spec.agentId,
			scopeId: spec.scopeId,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort,
			sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
			metrics: deps.metrics,
			profile,
			summaryWriter: deps.summaryWriter,
			compactionTokenThreshold: deps.compactionTokenThreshold,
			compactionCooldownMs: deps.compactionCooldownMs,
			attachmentProcessor,
		});
		agents.set(spec.scopeId, agent);
	}

	return agents;
}

export function createWebConversationAgent(
	config: AppConfig,
	deps: {
		sessionStore: SessionStorePort;
		contextBuilder: ContextBuilderPort;
		logger: Logger;
		recorder?: ConversationRecorder;
		appRoot: string;
		coreEnvironment: Record<string, string>;
		opencodePort: number;
	},
): WebConversationAgent {
	const profile = createWebConversationProfile({
		providerId: config.opencode.providerId,
		modelId: config.opencode.modelId,
		mcpServers: mcpServerConfigs(WEB_AGENT_ID, {
			appRoot: deps.appRoot,
			coreEnvironment: deps.coreEnvironment,
		}),
	});
	const sessionPort = new OpencodeSessionAdapter({
		port: deps.opencodePort,
		mcpServers: profile.mcpServers,
		builtinTools: profile.builtinTools,
		skillPermission: profile.skillPermission,
		skillPaths: opencodeSkillPaths(deps.appRoot),
		temperature: config.opencode.temperature,
		logger: deps.logger,
	});

	return new WebConversationAgent({
		agentId: WEB_AGENT_ID,
		scopeId: WEB_SCOPE_ID,
		sessionStore: deps.sessionStore,
		contextBuilder: deps.contextBuilder,
		logger: deps.logger,
		sessionPort,
		sessionMaxAgeMs: config.opencode.sessionMaxAgeHours * 3_600_000,
		profile,
		recorder: deps.recorder,
	});
}

// ─── Metrics ────────────────────────────────────────────────────

export function createMetrics(logger: Logger, port: number) {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.DISCORD_MESSAGES_RECEIVED, "Discord messages received");
	collector.registerCounter(METRIC.AI_REQUESTS, "Completed AI prompt requests");
	collector.registerCounter(METRIC.HEARTBEAT_TICKS, "Heartbeat scheduler ticks");
	collector.registerCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED, "Heartbeat reminders executed");
	collector.registerGauge(METRIC.BOT_INFO, "Bot information");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "AI prompt duration in seconds");
	collector.registerHistogram(METRIC.HEARTBEAT_TICK_DURATION, "Heartbeat tick duration in seconds");
	collector.registerGauge(METRIC.LLM_ACTIVE_SESSIONS, "Registered LLM sessions");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "LLM prompts currently processing");
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
	// Emotion estimation metrics
	collector.registerCounter(METRIC.EMOTION_ESTIMATION_ERRORS, "Emotion estimation errors total");
	collector.registerCounter(METRIC.EMOTION_ESTIMATION_SKIPS, "Emotion estimation skips total");
	// Drift metrics
	collector.registerGauge(METRIC.DRIFT_SCORE, "Character drift score per guild");
	collector.registerCounter(METRIC.DRIFT_AUDITS, "Character drift audit results");
	collector.registerCounter(METRIC.CRITIC_AUDITOR_SKIP_TOTAL, "Critic auditor skipped audits");
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

export async function buildCriticAuditorAdapter(
	soulPath: string,
	llm: MemoryLlmPort,
	dataDir: string,
	getBotUserId: () => string | undefined,
): Promise<CriticAuditorPort | undefined> {
	const soulFile = Bun.file(soulPath);
	if (!(await soulFile.exists())) return undefined;

	const characterDefinition = await soulFile.text();
	const driftCalculator = new DriftScoreCalculator(llm, characterDefinition);
	await driftCalculator.init();

	const storageCache = new Map<string, MemoryStorage>();
	return {
		audit(subject: string) {
			// gateway.start() 前に audit が呼ばれた場合、bot user id 未解決のため早期 return
			// (namespace 解決は scopeId バリデーションを行うため、それより前に判定する)
			const botUserId = getBotUserId();
			if (!botUserId) return Promise.resolve({ status: "skipped", reason: "no_bot_id" });

			let storage = storageCache.get(subject);
			if (!storage) {
				const namespace: MemoryNamespace =
					subject === HUA_SELF_SUBJECT ? INTERNAL_NAMESPACE : agentScopeNamespace(subject);
				mkdirSync(resolveMemoryDbDir(dataDir, namespace), { recursive: true });
				storage = new MemoryStorage(resolveMemoryDbPath(dataDir, namespace));
				storageCache.set(subject, storage);
			}
			const auditor = new CriticAuditor({
				llm,
				storage,
				driftCalculator,
				characterDefinition,
				botUserId,
			});
			return auditor.audit(subject);
		},
	};
}

export async function setupMemoryRecording(
	config: AppConfig,
	logger: Logger,
	opts: {
		memoryPort: number;
		metricsCollector?: PrometheusCollector;
		embeddingAdapter?: OllamaEmbeddingAdapter;
		root: string;
		/**
		 * Bot の Discord user id を遅延解決するための callback。
		 * gateway.start() より前に setupMemoryRecording が呼ばれるため、
		 * audit 実行時に最新値を取得する必要がある。
		 * 未解決の間 (undefined を返す) は audit が no-op (null) になる。
		 */
		getBotUserId?: () => string | undefined;
	},
): Promise<MemoryResources | undefined> {
	const dataDir = resolve(config.dataDir, "memory");

	try {
		const memorySessionPort = new OpencodeSessionAdapter({
			port: opts.memoryPort,
			mcpServers: {},
			builtinTools: OPENCODE_ALL_TOOLS_DISABLED,
			skillPermission: denyAllSkillPermission(),
			skillPaths: opencodeSkillPaths(opts.root),
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

		const overlaySoulPath = resolve(opts.root, "data/context/SOUL.md");
		const baseSoulPath = resolve(opts.root, "context/SOUL.md");
		const soulPath = existsSync(overlaySoulPath) ? overlaySoulPath : baseSoulPath;
		const criticAuditor = await buildCriticAuditorAdapter(soulPath, llm, dataDir, () =>
			opts.getBotUserId?.(),
		);

		const githubIssuePort = config.github
			? new GitHubIssueAdapter({
					token: config.github.token,
					owner: config.github.owner,
					repo: config.github.repo,
				})
			: undefined;

		const recorder = new MemoryConversationRecorder(llm, dataDir);
		const consolidationScheduler = new ConsolidationScheduler(
			recorder,
			logger,
			opts.metricsCollector,
			criticAuditor,
			githubIssuePort,
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
				message: formatDiscordMessage(msg),
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
				message: formatDiscordMessage(msg),
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
			message: formatDiscordMessage(msg),
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
	heartbeatScheduler.start();
	memoryResources?.consolidationScheduler.start();
	// DiscordAgent は lazy start: 最初の send() 呼び出しで自動的にポーリングループが起動する
	mcBrainManager?.start();
}
