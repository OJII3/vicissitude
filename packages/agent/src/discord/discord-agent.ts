import type {
	ContextBuilderPort,
	EventBuffer,
	Logger,
	MetricsCollector,
	OpencodeSessionPort,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { getHeartbeat } from "@vicissitude/store/queries";

import type { AgentProfile } from "../profile.ts";
import { AgentRunner } from "../runner.ts";

export interface DiscordAgentDeps {
	guildId: string;
	db: StoreDb;
	sessionStore: SessionStorePort;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	sessionPort: OpencodeSessionPort;
	eventBuffer: EventBuffer;
	sessionMaxAgeMs: number;
	metrics?: MetricsCollector;
	profile: AgentProfile;
	summaryWriter?: SessionSummaryWriter;
	/** agentId のプレフィックス（デフォルト: "discord"）。Heartbeat 専用エージェントなどでセッション分離に使用 */
	agentIdPrefix?: string;
	/** proactive compaction のトークン閾値。省略時は proactive compaction 無効 */
	compactionTokenThreshold?: number;
	/** compaction 間のクールダウン（ms）。デフォルト: 1_800_000 (30分) */
	compactionCooldownMs?: number;
}

export class DiscordAgent extends AgentRunner {
	constructor(deps: DiscordAgentDeps) {
		const agentId = `${deps.agentIdPrefix ?? "discord"}:${deps.guildId}`;
		super({
			profile: deps.profile,
			agentId,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort: deps.sessionPort,
			eventBuffer: deps.eventBuffer,
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
			metrics: deps.metrics,
			contextGuildId: deps.guildId,
			summaryWriter: deps.summaryWriter,
			compactionTokenThreshold: deps.compactionTokenThreshold,
			compactionCooldownMs: deps.compactionCooldownMs,
			heartbeatReader: {
				getLastSeenAt: (id) => getHeartbeat(deps.db, id),
			},
		});
	}
}
