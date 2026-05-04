import type {
	AgentResponse,
	AttachmentProcessor,
	ContextBuilderPort,
	Logger,
	MetricsCollector,
	OpencodeSessionPort,
	SendOptions,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "../profile.ts";
import { AgentRunner } from "../runner.ts";

export interface ConversationBreakConfig {
	compactionGapMs?: number;
	rotationGapMs?: number;
}

export interface DiscordAgentDeps {
	guildId: string;
	sessionStore: SessionStorePort;
	contextBuilder: ContextBuilderPort;
	logger: Logger;
	sessionPort: OpencodeSessionPort;
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
	/** テスト用時刻プロバイダー。デフォルト: Date.now */
	nowProvider?: () => number;
	/** 会話ブレイク検出設定 */
	conversationBreak?: ConversationBreakConfig;
	/** Discord 添付画像を通常モデル向けのテキスト観察へ変換する補助 */
	attachmentProcessor?: AttachmentProcessor;
}

export class DiscordAgent extends AgentRunner {
	private lastActivityAt: number | null = null;
	private lastChannelId: string | null = null;
	private readonly compactionGapMs: number;
	private readonly rotationGapMs: number;

	constructor(deps: DiscordAgentDeps) {
		const agentId = `${deps.agentIdPrefix ?? "discord"}:${deps.guildId}`;
		super({
			profile: deps.profile,
			agentId,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort: deps.sessionPort,
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
			metrics: deps.metrics,
			contextGuildId: deps.guildId,
			summaryWriter: deps.summaryWriter,
			compactionTokenThreshold: deps.compactionTokenThreshold,
			compactionCooldownMs: deps.compactionCooldownMs,
			nowProvider: deps.nowProvider,
			attachmentProcessor: deps.attachmentProcessor,
		});
		this.compactionGapMs = deps.conversationBreak?.compactionGapMs ?? 1_800_000;
		this.rotationGapMs = deps.conversationBreak?.rotationGapMs ?? 21_600_000;
	}

	override send(options: SendOptions): Promise<AgentResponse> {
		const now = this.nowProvider();
		const channelId = options.channelId ?? null;

		if (this.lastActivityAt !== null) {
			const gap = now - this.lastActivityAt;
			const channelChanged =
				channelId !== null && this.lastChannelId !== null && channelId !== this.lastChannelId;

			if (gap >= this.rotationGapMs) {
				void this.requestSessionRotation();
			} else if (gap >= this.compactionGapMs || (channelChanged && gap > 0)) {
				this.pendingCompaction = true;
			}
		}

		this.lastActivityAt = now;
		if (channelId !== null) this.lastChannelId = channelId;

		return super.send(options);
	}
}
