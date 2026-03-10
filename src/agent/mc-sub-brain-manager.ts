/* oxlint-disable max-dependencies -- manager requires multiple DI dependencies */
import { resolve } from "path";

import { MC_SUB_BRAIN_GUILD_ID } from "../core/constants.ts";
import type { Logger } from "../core/types.ts";
import type { StoreDb } from "../store/db.ts";
import { clearSessionLock, consumeBridgeEventsByType } from "../store/mc-bridge.ts";
import { MinecraftEventBuffer } from "../store/mc-sub-event-buffer.ts";
import { mcpMinecraftSubBrainConfigs } from "./mcp-config.ts";
import { MinecraftContextBuilder } from "./minecraft-context-builder.ts";
import { createMinecraftProfile } from "./profiles/minecraft.ts";
import { AgentRunner } from "./runner.ts";
import type { SessionStore } from "./session-store.ts";

const MC_LIFECYCLE_POLL_MS = 10_000;

export interface McSubBrainManagerDeps {
	db: StoreDb;
	sessionStore: SessionStore;
	logger: Logger;
	root: string;
	port: number;
	providerId: string;
	modelId: string;
	sessionMaxAgeMs: number;
}

/**
 * Minecraft サブブレインの生成・起動・停止を管理する。
 * ブリッジテーブルの lifecycle イベントを定期ポーリングし、
 * start/stop 指示に応じてランナーを制御する。
 */
export class McSubBrainManager {
	private runner: AgentRunner | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly deps: McSubBrainManagerDeps) {}

	/** 初期起動（lifecycle ポーリングを開始。ランナーは minecraft_start_session がトリガー） */
	start(): void {
		clearSessionLock(this.deps.db);
		this.pollTimer = setInterval(() => this.checkLifecycleEvents(), MC_LIFECYCLE_POLL_MS);
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.stopRunner();
	}

	private startRunner(): void {
		if (this.runner) return;

		const { root, sessionStore, logger, port, providerId, modelId, sessionMaxAgeMs } = this.deps;
		const mcEventBuffer = new MinecraftEventBuffer(30_000);
		const mcContextBuilder = new MinecraftContextBuilder(
			resolve(root, "data/context/minecraft"),
			resolve(root, "context/minecraft"),
		);
		const mcProfile = createMinecraftProfile({
			providerId,
			modelId,
			mcpServers: mcpMinecraftSubBrainConfigs(),
		});
		this.runner = new AgentRunner({
			profile: mcProfile,
			guildId: MC_SUB_BRAIN_GUILD_ID,
			sessionStore,
			contextBuilder: mcContextBuilder,
			logger,
			port,
			eventBuffer: mcEventBuffer,
			sessionMaxAgeMs,
		});
		this.runner.startPollingLoop().catch((err) => {
			logger.error("[McSubBrainManager] polling loop unexpectedly rejected", err);
		});
		logger.info("[McSubBrainManager] sub-brain started");
	}

	private stopRunner(): void {
		if (!this.runner) return;
		this.runner.stop();
		this.runner = undefined;
		this.deps.logger.info("[McSubBrainManager] sub-brain stopped");
	}

	private checkLifecycleEvents(): void {
		try {
			const events = consumeBridgeEventsByType(this.deps.db, "to_sub", "lifecycle");
			for (const event of events) {
				if (event.payload === "start") {
					this.deps.logger.info("[McSubBrainManager] received lifecycle start");
					this.startRunner();
				} else if (event.payload === "stop") {
					this.deps.logger.info("[McSubBrainManager] received lifecycle stop");
					this.stopRunner();
				}
			}
		} catch (err) {
			this.deps.logger.error("[McSubBrainManager] lifecycle check error", err);
		}
	}
}
