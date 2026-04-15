import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import type {
	ContextBuilderPort,
	Logger,
	MetricsCollector,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { SqliteEventBuffer } from "@vicissitude/store/event-buffer";
import { consumeRotationRequest, getHeartbeat } from "@vicissitude/store/queries";

import { mcpServerConfigs } from "../mcp-config.ts";
import { AgentRunner } from "../runner.ts";
import { createConversationProfile } from "./profile.ts";

export interface DiscordAgentDeps {
	guildId: string;
	db: StoreDb;
	sessionStore: SessionStorePort;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	/** OpenCode SDK サーバーのポート番号 */
	opencodePort: number;
	sessionMaxAgeMs: number;
	metrics?: MetricsCollector;
	model: { providerId: string; modelId: string };
	summaryWriter?: SessionSummaryWriter;
	/** agentId のプレフィックス（デフォルト: "discord"）。Heartbeat 専用エージェントなどでセッション分離に使用 */
	agentIdPrefix?: string;
	appRoot: string;
	coreMcpPort: number;
}

export class DiscordAgent extends AgentRunner {
	constructor(deps: DiscordAgentDeps) {
		const agentId = `${deps.agentIdPrefix ?? "discord"}:${deps.guildId}`;
		const profile = createConversationProfile({
			...deps.model,
			mcpServers: mcpServerConfigs(agentId, {
				appRoot: deps.appRoot,
				coreMcpPort: deps.coreMcpPort,
			}),
		});
		super({
			profile,
			agentId,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort: new OpencodeSessionAdapter({
				port: deps.opencodePort,
				mcpServers: profile.mcpServers,
				builtinTools: profile.builtinTools,
				temperature: 0.7,
				logger: deps.logger,
			}),
			eventBuffer: new SqliteEventBuffer(deps.db, agentId, deps.logger),
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
			metrics: deps.metrics,
			contextGuildId: deps.guildId,
			summaryWriter: deps.summaryWriter,
			heartbeatReader: {
				getLastSeenAt: (id) => getHeartbeat(deps.db, id),
				consumeRotationRequest: (id) => consumeRotationRequest(deps.db, id),
			},
		});
	}
}
