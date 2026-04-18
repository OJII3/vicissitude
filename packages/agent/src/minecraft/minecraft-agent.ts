import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
import type {
	ContextBuilderPort,
	EventBuffer,
	Logger,
	OpencodeSessionPort,
	SessionStorePort,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "../profile.ts";
import { AgentRunner } from "../runner.ts";

export interface MinecraftAgentDeps {
	sessionStore: SessionStorePort;
	logger: Logger;
	eventBuffer: EventBuffer;
	sessionPort: OpencodeSessionPort;
	contextBuilder: ContextBuilderPort;
	sessionMaxAgeMs: number;
	profile: AgentProfile;
	/** proactive compaction のトークン閾値。省略時は proactive compaction 無効 */
	compactionTokenThreshold?: number;
	/** compaction 間のクールダウン（ms）。デフォルト: 1_800_000 (30分) */
	compactionCooldownMs?: number;
}

export class MinecraftAgent extends AgentRunner {
	constructor(deps: MinecraftAgentDeps) {
		super({
			profile: deps.profile,
			agentId: MINECRAFT_AGENT_ID,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort: deps.sessionPort,
			eventBuffer: deps.eventBuffer,
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
			compactionTokenThreshold: deps.compactionTokenThreshold,
			compactionCooldownMs: deps.compactionCooldownMs,
		});
	}
}
