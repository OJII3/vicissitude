import {
	HEARTBEAT_SESSION_PREFIX,
	scopeKeyFromHeartbeatSessionKey,
} from "@vicissitude/shared/namespace";

// ─── Agent Metric Labels ────────────────────────────────────────

export interface AgentMetricLabelOptions {
	agentId: string;
	scopeId?: string;
	sessionKey?: string;
	trigger?: string;
	providerId: string;
	modelId: string;
}

const DISCORD_HEARTBEAT_PREFIX = "discord:heartbeat:";
const DISCORD_DM_PREFIX = "discord:dm:";
const DISCORD_PREFIX = "discord:";
const MINECRAFT_PREFIX = "minecraft:";
const WEB_PREFIX = "web:";

/**
 * agentId の表面識別子。spec/agent/runner-llm-metrics.spec.ts がテスト用 agentId
 * (`"discord:guild-1"` 等) で `agent_kind="discord"` を期待しているため、
 * `parseAgentId` のような guild-id 厳格検証ではなく、プレフィックスベースの
 * 緩いマッチングを使う（shared/namespace の正規表現と無関係に動く）。
 */
export function inferAgentKind(agentId: string): string {
	if (agentId.startsWith(DISCORD_HEARTBEAT_PREFIX)) return "discord_heartbeat";
	if (agentId.startsWith(DISCORD_PREFIX)) return "discord";
	if (agentId.startsWith(MINECRAFT_PREFIX)) return "minecraft";
	if (agentId.startsWith(WEB_PREFIX)) return "web";
	return "unknown";
}

/**
 * sessionKey から trigger を導出する。session-key 規約は shared/namespace に
 * 集約済み（`HEARTBEAT_SESSION_PREFIX`）。trigger の判別は sessionKey の
 * 表面パターンに基づく観測的な分類。
 */
export function inferTrigger(sessionKey: string): string {
	if (sessionKey === "home" || sessionKey.endsWith(":_channel")) return "home";
	if (sessionKey === "dm" || sessionKey.startsWith(DISCORD_DM_PREFIX)) return "dm";
	if (sessionKey.startsWith(HEARTBEAT_SESSION_PREFIX)) return "heartbeat";
	if (sessionKey.startsWith(DISCORD_HEARTBEAT_PREFIX)) return "heartbeat";
	if (sessionKey === "mention" || sessionKey.startsWith(DISCORD_PREFIX)) return "mention";
	if (sessionKey.startsWith(MINECRAFT_PREFIX)) return "minecraft";
	if (sessionKey.startsWith(WEB_PREFIX)) return "mention";
	return "unknown";
}

/** sessionKey から scopeId を導出する。 */
export function inferScopeId(sessionKey: string): string | undefined {
	const heartbeatScopeKey = scopeKeyFromHeartbeatSessionKey(sessionKey);
	if (heartbeatScopeKey !== null) return heartbeatScopeKey;

	if (sessionKey.startsWith("discord:guild:")) {
		return sessionKey;
	}

	if (sessionKey.startsWith(DISCORD_DM_PREFIX)) {
		return sessionKey;
	}

	if (sessionKey.startsWith(DISCORD_PREFIX)) {
		const [, first, second] = sessionKey.split(":");
		if (first === "dm") return second ? `${DISCORD_DM_PREFIX}${second}` : undefined;
		const discordId = first === "heartbeat" ? second : first;
		return discordId ? `discord:guild:${discordId}` : undefined;
	}

	return undefined;
}

/**
 * agentId から scopeId を導出する（inferAgentKind と同じ緩いプレフィックス規約）。
 */
function inferScopeIdFromAgentId(agentId: string): string | undefined {
	if (agentId.startsWith(DISCORD_HEARTBEAT_PREFIX)) {
		return `discord:guild:${agentId.slice(DISCORD_HEARTBEAT_PREFIX.length)}`;
	}
	if (agentId.startsWith(DISCORD_DM_PREFIX)) {
		return agentId;
	}
	if (agentId.startsWith(DISCORD_PREFIX)) {
		return `discord:guild:${agentId.slice(DISCORD_PREFIX.length)}`;
	}
	if (agentId.startsWith(WEB_PREFIX)) {
		return agentId;
	}
	return undefined;
}

export function buildAgentMetricLabels(options: AgentMetricLabelOptions): Record<string, string> {
	const sessionScopeId = options.sessionKey ? inferScopeId(options.sessionKey) : undefined;
	const scopeId =
		options.scopeId ?? sessionScopeId ?? inferScopeIdFromAgentId(options.agentId) ?? "none";
	const trigger =
		options.trigger ?? (options.sessionKey ? inferTrigger(options.sessionKey) : "unknown");

	return {
		agent_kind: inferAgentKind(options.agentId),
		agent_id: options.agentId,
		scope_id: scopeId,
		trigger,
		provider: options.providerId,
		model: options.modelId,
	};
}
