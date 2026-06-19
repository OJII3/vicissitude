import { DiscordAgent } from "@vicissitude/agent/discord/discord-agent";
import { ImageAttachmentDescriber } from "@vicissitude/agent/discord/image-attachment-describer";
import { createConversationProfile } from "@vicissitude/agent/discord/profile";
import { mcpServerConfigs } from "@vicissitude/agent/mcp-config";
import { createWebConversationProfile } from "@vicissitude/agent/web/profile";
import { WEB_AGENT_ID, WEB_SCOPE_ID, WebConversationAgent } from "@vicissitude/agent/web/web-agent";
import { discordDmScopeId, discordScopeId } from "@vicissitude/memory/namespace";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import type {
	ConversationRecorder,
	ContextBuilderPort,
	Logger,
	MetricsCollector,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";

import type { AppConfig } from "../config.ts";
import {
	buildAgentDiscordEnvironment,
	buildOpencodeShellAgentEnvironment,
	discordOpencodeSkillPaths,
	prepareOpencodeShellAgentDirectory,
} from "./environment.ts";

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

function canUseShellAgent(config: AppConfig, agentId: string): boolean {
	return !!config.shellAgent && !isHeartbeatAgentId(agentId);
}

export function createDiscordAgents(
	config: AppConfig,
	agentSpecs: DiscordAgentSpec[],
	deps: {
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
		const shellAgentEnabled = canUseShellAgent(config, spec.agentId);
		const shellAgentDirectory = shellAgentEnabled
			? prepareOpencodeShellAgentDirectory(config, spec.agentId)
			: undefined;
		const { profile, opencode: opencodeProfile } = createConversationProfile({
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
			shellWorkspaceSubagent: shellAgentEnabled ? config.shellAgent?.agent : undefined,
			shellWorkspaceBackgroundSubagents: shellAgentEnabled
				? config.shellAgent?.backgroundSubagents
				: undefined,
		});
		const sessionPort = new OpencodeSessionAdapter({
			port: agentPort,
			mcpServers: profile.mcpServers,
			builtinTools: opencodeProfile.builtinTools,
			skillPermission: opencodeProfile.skillPermission,
			skillPaths: discordOpencodeSkillPaths(deps.appRoot, { shellAgentEnabled }),
			agents: opencodeProfile.opencodeAgents,
			defaultAgent: opencodeProfile.defaultAgent,
			primaryTools: opencodeProfile.primaryTools,
			temperature: opencode.temperature,
			directory: shellAgentDirectory,
			environment: shellAgentEnabled
				? buildOpencodeShellAgentEnvironment(config, shellAgentDirectory)
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
	const { profile, opencode: opencodeProfile } = createWebConversationProfile({
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
		builtinTools: opencodeProfile.builtinTools,
		skillPermission: opencodeProfile.skillPermission,
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
