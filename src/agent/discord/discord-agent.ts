import type { ContextBuilderPort, Logger, MetricsCollector } from "@vicissitude/shared/types";
import { OpencodeSessionAdapter } from "../../opencode/session-adapter.ts";
import type { StoreDb } from "../../store/db.ts";
import { SqliteEventBuffer } from "../../store/event-buffer.ts";
import { mcpServerConfigs } from "../mcp-config.ts";
import { AgentRunner } from "../runner.ts";
import type { SessionStore } from "../session-store.ts";
import { createConversationProfile } from "./profile.ts";

export interface DiscordAgentDeps {
	guildId: string;
	db: StoreDb;
	sessionStore: SessionStore;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	/** OpenCode SDK サーバーのポート番号 */
	opencodePort: number;
	sessionMaxAgeMs: number;
	metrics?: MetricsCollector;
	model: { providerId: string; modelId: string };
}

export class DiscordAgent extends AgentRunner {
	constructor(deps: DiscordAgentDeps) {
		const profile = createConversationProfile({
			...deps.model,
			mcpServers: mcpServerConfigs(),
		});
		super({
			profile,
			agentId: `discord:${deps.guildId}`,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort: new OpencodeSessionAdapter({
				port: deps.opencodePort,
				mcpServers: profile.mcpServers,
				builtinTools: profile.builtinTools,
			}),
			eventBuffer: new SqliteEventBuffer(deps.db, `discord:${deps.guildId}`, deps.logger),
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
			metrics: deps.metrics,
			contextGuildId: deps.guildId,
		});
	}
}
