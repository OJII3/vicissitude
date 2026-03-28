import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
import type { Logger } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { SqliteEventBuffer } from "@vicissitude/store/event-buffer";
import { clearSessionLock, hasSessionLock } from "@vicissitude/store/mc-bridge";
import { appendEvent } from "@vicissitude/store/queries";

import type { SessionStore } from "../session-store.ts";
import { MinecraftAgent } from "./minecraft-agent.ts";

const DEFAULT_LIFECYCLE_POLL_MS = 10_000;

export interface McBrainManagerDeps {
	db: StoreDb;
	sessionStore: SessionStore;
	logger: Logger;
	root: string;
	opencodePort: number;
	providerId: string;
	modelId: string;
	sessionMaxAgeMs: number;
	/** ライフサイクルポーリング間隔（ms）。デフォルト 10_000 */
	lifecyclePollMs?: number;
}

/**
 * Minecraft エージェントの生成・起動・停止を管理する。
 * mc_session_lock テーブルの状態を定期ポーリングし、
 * ロックの有無に応じてエージェントを制御する。
 */
export class McBrainManager {
	private agent: MinecraftAgent | undefined;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private stopping = false;
	private pollCount = 0;
	private readonly pollMs: number;

	constructor(private readonly deps: McBrainManagerDeps) {
		this.pollMs = deps.lifecyclePollMs ?? DEFAULT_LIFECYCLE_POLL_MS;
	}

	/** 初期起動（lifecycle ポーリングを開始。エージェントは minecraft_start_session がトリガー） */
	start(): void {
		// シングルプロセス前提: 再起動時に残存ロックを強制クリア
		clearSessionLock(this.deps.db);
		this.pollCount = 0;
		this.schedulePoll();
		this.deps.logger.info(`[McBrainManager] lifecycle polling started (interval=${this.pollMs}ms)`);
	}

	stop(): void {
		if (this.pollTimer) {
			this.deps.logger.info("[McBrainManager] stopping lifecycle polling");
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.stopAgent();
	}

	/** 前回の処理完了後に次のポーリングをスケジュールする（setInterval の代わりに再帰 setTimeout） */
	private schedulePoll(): void {
		this.pollTimer = setTimeout(() => {
			this.pollCount++;
			if (this.pollCount % 30 === 0) {
				const agentState = this.agent ? "running" : "idle";
				this.deps.logger.info(
					`[McBrainManager] alive (polls=${this.pollCount}, agent=${agentState})`,
				);
			}
			this.checkLifecycleState();
			if (!this.stopping && this.pollTimer !== undefined) {
				this.schedulePoll();
			}
		}, this.pollMs);
	}

	private createAgent(): void {
		if (this.agent || this.stopping) return;

		const { db, sessionStore, logger, root, opencodePort, providerId, modelId, sessionMaxAgeMs } =
			this.deps;
		this.agent = new MinecraftAgent({
			eventBuffer: new SqliteEventBuffer(db, MINECRAFT_AGENT_ID, logger),
			sessionStore,
			logger,
			root,
			opencodePort,
			sessionMaxAgeMs,
			model: { providerId, modelId },
		});
		// 初期イベントを挿入してポーリングループの最初の waitForEvents を通過させる
		const bootstrapEvent = {
			ts: new Date().toISOString(),
			content: "Minecraft セッション開始",
			authorId: "system",
			authorName: "system",
			messageId: `mc-bootstrap-${Date.now()}`,
		};
		appendEvent(db, MINECRAFT_AGENT_ID, JSON.stringify(bootstrapEvent));
		this.agent.ensurePolling();
		logger.info("[McBrainManager] minecraft brain started");
	}

	private stopAgent(): void {
		if (!this.agent) return;
		this.stopping = true;
		this.agent.stop();
		this.agent = undefined;
		this.deps.logger.info("[McBrainManager] minecraft brain stopped");
		this.stopping = false;
	}

	/** mc_session_lock の有無でエージェントの起動/停止を判断する */
	private checkLifecycleState(): void {
		if (this.stopping) return;
		try {
			const lockActive = hasSessionLock(this.deps.db);
			if (lockActive && !this.agent) {
				this.deps.logger.info("[McBrainManager] session lock detected, starting agent");
				this.createAgent();
			} else if (!lockActive && this.agent) {
				this.deps.logger.info("[McBrainManager] session lock released, stopping agent");
				this.stopAgent();
			}
		} catch (err) {
			this.deps.logger.error("[McBrainManager] lifecycle check error", err);
		}
	}
}
