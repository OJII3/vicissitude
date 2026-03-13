import type { Logger } from "../../core/types.ts";
import type { StoreDb } from "../../store/db.ts";
import { clearSessionLock, consumeBridgeEventsByType } from "../../store/mc-bridge.ts";
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
 * ブリッジテーブルの lifecycle イベントを定期ポーリングし、
 * start/stop 指示に応じてエージェントを制御する。
 *
 * 前提: シングルプロセス構成。複数プロセスが同一 DB を共有する場合は
 * clearSessionLock やポート管理の見直しが必要。
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
			this.checkLifecycleEvents();
			if (!this.stopping && this.pollTimer !== undefined) {
				this.schedulePoll();
			}
		}, this.pollMs);
	}

	private createAgent(): void {
		if (this.agent || this.stopping) return;

		const { sessionStore, logger, root, opencodePort, providerId, modelId, sessionMaxAgeMs } =
			this.deps;
		this.agent = new MinecraftAgent({
			sessionStore,
			logger,
			root,
			opencodePort,
			sessionMaxAgeMs,
			model: { providerId, modelId },
		});
		// MinecraftAgent は MinecraftEventBuffer (タイマーベース) を内蔵しているため、
		// ensurePolling() でポーリングループを即時起動する
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

	private checkLifecycleEvents(): void {
		if (this.stopping) return;
		try {
			const events = consumeBridgeEventsByType(this.deps.db, "to_minecraft", "lifecycle");
			for (const event of events) {
				if (event.payload === "start") {
					this.deps.logger.info("[McBrainManager] received lifecycle start");
					this.createAgent();
				} else if (event.payload === "stop") {
					this.deps.logger.info("[McBrainManager] received lifecycle stop");
					this.stopAgent();
				}
			}
		} catch (err) {
			this.deps.logger.error("[McBrainManager] lifecycle check error", err);
		}
	}
}
