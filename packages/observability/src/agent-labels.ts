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

export function inferAgentKind(agentId: string): string {
	if (agentId.startsWith("discord:heartbeat:")) return "discord_heartbeat";
	if (agentId.startsWith("discord:")) return "discord";
	if (agentId.startsWith("minecraft:")) return "minecraft";
	return "unknown";
}

export function inferTrigger(sessionKey: string): string {
	if (sessionKey === "home" || sessionKey.endsWith(":_channel")) return "home";
	if (sessionKey === "dm" || sessionKey.startsWith("discord:dm:")) return "dm";
	if (sessionKey.startsWith(HEARTBEAT_SESSION_PREFIX)) return "heartbeat";
	if (sessionKey.startsWith("discord:heartbeat:")) return "heartbeat";
	if (sessionKey === "mention" || sessionKey.startsWith("discord:")) return "mention";
	if (sessionKey.startsWith("minecraft:")) return "minecraft";
	return "unknown";
}

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

function inferScopeIdFromAgentId(agentId: string): string | undefined {
	if (agentId.startsWith("discord:heartbeat:")) {
		return `discord:guild:${agentId.slice("discord:heartbeat:".length)}`;
	}
	if (agentId.startsWith("discord:dm:")) {
		return agentId;
	}
	if (agentId.startsWith("discord:")) return `discord:guild:${agentId.slice("discord:".length)}`;
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
