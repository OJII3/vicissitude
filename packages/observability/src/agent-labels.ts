import {
	type DiscordAgentRole,
	parseAgentId,
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

/**
 * parseAgentId の結果プラットフォームを agent_kind ラベルにマップする。
 * `inferAgentKind` / `inferScopeIdFromAgentId` の単一ソース。
 */
function agentKindFromPlatform(
	platform: "discord" | "web" | "internal",
	role: DiscordAgentRole | undefined,
): string {
	if (platform === "discord") return role === "heartbeat" ? "discord_heartbeat" : "discord";
	if (platform === "web") return "web";
	return "internal";
}

/**
 * agentId の表面識別子。`parseAgentId` を緩いモードで呼び、観測的な
 * プレフィックス分類を行う。spec/agent/runner-llm-metrics.spec.ts のように
 * 緩い agentId 表記 (`"discord:guild-1"`) を使う spec でも kind を導出できる
 * ことが要件。`minecraft:` は `parseAgentId` の対象外なので special case として扱う。
 */
export function inferAgentKind(agentId: string): string {
	const parsed = parseAgentId(agentId, { strict: false });
	if (parsed) {
		const role = parsed.platform === "discord" ? parsed.role : undefined;
		return agentKindFromPlatform(parsed.platform, role);
	}
	// parseAgentId は minecraft: プレフィックスを扱わないため、ここで個別に救済する。
	if (agentId.startsWith("minecraft:")) return "minecraft";
	return "unknown";
}

/**
 * sessionKey から trigger を導出する。session-key 規約は shared/namespace に
 * 集約済み（`HEARTBEAT_SESSION_PREFIX`）。trigger の判別は sessionKey の
 * 表面パターンに基づく観測的な分類。
 */
export function inferTrigger(sessionKey: string): string {
	if (sessionKey === "home" || sessionKey.endsWith(":_channel")) return "home";
	if (sessionKey === "dm" || sessionKey.startsWith("discord:dm:")) return "dm";
	if (sessionKey.startsWith("system:heartbeat:")) return "heartbeat";
	if (sessionKey.startsWith("discord:heartbeat:")) return "heartbeat";
	if (sessionKey === "mention" || sessionKey.startsWith("discord:")) return "mention";
	if (sessionKey.startsWith("minecraft:")) return "minecraft";
	if (sessionKey.startsWith("web:")) return "mention";
	return "unknown";
}

/** sessionKey から scopeId を導出する。 */
export function inferScopeId(sessionKey: string): string | undefined {
	const heartbeatScopeKey = scopeKeyFromHeartbeatSessionKey(sessionKey);
	if (heartbeatScopeKey !== null) return heartbeatScopeKey;

	if (sessionKey.startsWith("discord:guild:")) {
		return sessionKey;
	}

	if (sessionKey.startsWith("discord:dm:")) {
		return sessionKey;
	}

	if (sessionKey.startsWith("discord:")) {
		const [, first, second] = sessionKey.split(":");
		if (first === "dm") return second ? `discord:dm:${second}` : undefined;
		const discordId = first === "heartbeat" ? second : first;
		return discordId ? `discord:guild:${discordId}` : undefined;
	}

	return undefined;
}

/**
 * agentId から scopeId を導出する。`parseAgentId` 緩いモードの scopeId を
 * そのまま利用する。platform が internal の場合 (例: `internal:something`)
 * は scopeId フィールドが存在しないので undefined を返す。
 */
function inferScopeIdFromAgentId(agentId: string): string | undefined {
	const parsed = parseAgentId(agentId, { strict: false });
	if (!parsed || parsed.platform === "internal") return undefined;
	return parsed.scopeId;
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
