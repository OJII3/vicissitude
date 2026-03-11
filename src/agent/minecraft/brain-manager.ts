/* oxlint-disable max-dependencies -- manager requires multiple DI dependencies */
import { resolve } from "path";

import { MC_BRAIN_GUILD_ID, MC_BRAIN_WAKE_SIGNAL_RELATIVE_PATH } from "../../core/constants.ts";
import type { Logger, OpencodeSessionPort } from "../../core/types.ts";
import type { StoreDb } from "../../store/db.ts";
import { clearSessionLock, consumeBridgeEventsByType } from "../../store/mc-bridge.ts";
import { MinecraftEventBuffer } from "../../store/minecraft-event-buffer.ts";
import { mcpMinecraftConfigs } from "../mcp-config.ts";
import { AgentRunner } from "../runner.ts";
import type { SessionStore } from "../session-store.ts";
import { MinecraftContextBuilder } from "./context-builder.ts";
import { createMinecraftProfile } from "./profile.ts";

const DEFAULT_LIFECYCLE_POLL_MS = 10_000;

export interface McBrainManagerDeps {
	db: StoreDb;
	sessionStore: SessionStore;
	logger: Logger;
	root: string;
	createSessionPort: () => OpencodeSessionPort;
	providerId: string;
	modelId: string;
	sessionMaxAgeMs: number;
	/** ライフサイクルポーリング間隔（ms）。デフォルト 10_000 */
	lifecyclePollMs?: number;
}

/**
 * Minecraft エージェントの生成・起動・停止を管理する。
 * ブリッジテーブルの lifecycle イベントを定期ポーリングし、
 * start/stop 指示に応じてランナーを制御する。
 *
 * 前提: シングルプロセス構成。複数プロセスが同一 DB を共有する場合は
 * clearSessionLock やポート管理の見直しが必要。
 */
export class McBrainManager {
	private runner: AgentRunner | undefined;
	private runningPromise: Promise<void> | undefined;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private stopping = false;
	private pollCount = 0;
	private readonly pollMs: number;

	constructor(private readonly deps: McBrainManagerDeps) {
		this.pollMs = deps.lifecyclePollMs ?? DEFAULT_LIFECYCLE_POLL_MS;
	}

	/** 初期起動（lifecycle ポーリングを開始。ランナーは minecraft_start_session がトリガー） */
	start(): void {
		// シングルプロセス前提: 再起動時に残存ロックを強制クリア
		clearSessionLock(this.deps.db);
		this.pollCount = 0;
		this.schedulePoll();
		this.deps.logger.info(`[McBrainManager] lifecycle polling started (interval=${this.pollMs}ms)`);
	}

	async stop(): Promise<void> {
		if (this.pollTimer) {
			this.deps.logger.info("[McBrainManager] stopping lifecycle polling");
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		await this.stopRunner();
	}

	/** 前回の処理完了後に次のポーリングをスケジュールする（setInterval の代わりに再帰 setTimeout） */
	private schedulePoll(): void {
		this.pollTimer = setTimeout(async () => {
			this.pollCount++;
			if (this.pollCount % 30 === 0) {
				const runnerState = this.runner ? "running" : "idle";
				this.deps.logger.info(
					`[McBrainManager] alive (polls=${this.pollCount}, runner=${runnerState})`,
				);
			}
			await this.checkLifecycleEvents();
			if (!this.stopping && this.pollTimer !== undefined) {
				this.schedulePoll();
			}
		}, this.pollMs);
	}

	private startRunner(): void {
		if (this.runner || this.stopping) return;

		const { root, sessionStore, logger, createSessionPort, providerId, modelId, sessionMaxAgeMs } =
			this.deps;
		const mcEventBuffer = new MinecraftEventBuffer(
			30_000,
			resolve(root, MC_BRAIN_WAKE_SIGNAL_RELATIVE_PATH),
		);
		const mcContextBuilder = new MinecraftContextBuilder(
			resolve(root, "data/context/minecraft"),
			resolve(root, "context/minecraft"),
		);
		const mcProfile = createMinecraftProfile({
			providerId,
			modelId,
			mcpServers: mcpMinecraftConfigs(),
		});
		this.runner = new AgentRunner({
			profile: mcProfile,
			guildId: MC_BRAIN_GUILD_ID,
			sessionStore,
			contextBuilder: mcContextBuilder,
			logger,
			sessionPort: createSessionPort(),
			eventBuffer: mcEventBuffer,
			sessionMaxAgeMs,
		});
		this.runningPromise = this.runner.startPollingLoop().catch((err) => {
			logger.error("[McBrainManager] polling loop unexpectedly rejected", err);
		});
		logger.info("[McBrainManager] minecraft brain started");
	}

	private async stopRunner(): Promise<void> {
		if (!this.runner) return;
		this.stopping = true;
		this.runner.stop();
		this.runner = undefined;
		if (this.runningPromise) {
			await this.runningPromise;
			this.runningPromise = undefined;
		}
		this.deps.logger.info("[McBrainManager] minecraft brain stopped");
		this.stopping = false;
	}

	private async checkLifecycleEvents(): Promise<void> {
		if (this.stopping) return;
		try {
			const events = consumeBridgeEventsByType(this.deps.db, "to_minecraft", "lifecycle");
			for (const event of events) {
				if (event.payload === "start") {
					this.deps.logger.info("[McBrainManager] received lifecycle start");
					this.startRunner();
				} else if (event.payload === "stop") {
					this.deps.logger.info("[McBrainManager] received lifecycle stop");
					// oxlint-disable-next-line no-await-in-loop -- lifecycle events must be processed sequentially
					await this.stopRunner();
				}
			}
		} catch (err) {
			this.deps.logger.error("[McBrainManager] lifecycle check error", err);
		}
	}
}
