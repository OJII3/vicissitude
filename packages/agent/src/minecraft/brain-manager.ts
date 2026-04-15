/* oxlint-disable max-dependencies -- brain-manager creates MinecraftAgent with all DI dependencies */
import { resolve } from "path";

import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import type { EventBuffer, Logger, SessionStorePort } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { SqliteEventBuffer } from "@vicissitude/store/event-buffer";
import { clearSessionLock, hasSessionLock } from "@vicissitude/store/mc-bridge";
import { appendEvent } from "@vicissitude/store/queries";

import { mcpMinecraftConfigs } from "../mcp-config.ts";
import { MinecraftContextBuilder } from "./context-builder.ts";
import { MinecraftAgent } from "./minecraft-agent.ts";
import { createMinecraftProfile } from "./profile.ts";

const DEFAULT_LIFECYCLE_POLL_MS = 10_000;

export interface McBrainManagerDeps {
	db: StoreDb;
	sessionStore: SessionStorePort;
	logger: Logger;
	root: string;
	opencodePort: number;
	providerId: string;
	modelId: string;
	sessionMaxAgeMs: number;
	/** EventBuffer ファクトリ。省略時は SqliteEventBuffer を生成 */
	eventBufferFactory?: (agentId: string) => EventBuffer;
	/** ライフサイクルポーリング間隔（ms）。デフォルト 10_000 */
	lifecyclePollMs?: number;
	mcHost?: string;
	mcMcpPort?: string;
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
		this.deps.logger.info(
			`[mc-brain-manager] lifecycle polling started (interval=${this.pollMs}ms)`,
		);
	}

	stop(): void {
		if (this.pollTimer) {
			this.deps.logger.info("[mc-brain-manager] stopping lifecycle polling");
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
					`[mc-brain-manager] alive (polls=${this.pollCount}, agent=${agentState})`,
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

		const { deps } = this;
		const profile = createMinecraftProfile({
			providerId: deps.providerId,
			modelId: deps.modelId,
			mcpServers: mcpMinecraftConfigs({
				appRoot: deps.root,
				mcHost: deps.mcHost,
				mcMcpPort: deps.mcMcpPort,
			}),
		});
		const sessionPort = new OpencodeSessionAdapter({
			port: deps.opencodePort,
			mcpServers: profile.mcpServers,
			builtinTools: profile.builtinTools,
			temperature: 0.7,
			logger: deps.logger,
		});
		const overlayDir: string = resolve(deps.root, "data/context/minecraft");
		const baseDir: string = resolve(deps.root, "context/minecraft");
		const contextBuilder = new MinecraftContextBuilder(overlayDir, baseDir);
		const eventBuffer = deps.eventBufferFactory
			? deps.eventBufferFactory(MINECRAFT_AGENT_ID)
			: new SqliteEventBuffer(deps.db, MINECRAFT_AGENT_ID, deps.logger, (err) => {
					deps.logger.warn(`[mc-brain-manager] event buffer poll error`, err);
				});

		this.agent = new MinecraftAgent({
			eventBuffer,
			sessionPort,
			contextBuilder,
			sessionStore: deps.sessionStore,
			logger: deps.logger,
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
			profile,
		});
		// 初期イベントを挿入してポーリングループの最初の waitForEvents を通過させる
		const bootstrapEvent = {
			ts: new Date().toISOString(),
			content: "Minecraft セッション開始",
			authorId: "system",
			authorName: "system",
			messageId: `mc-bootstrap-${Date.now()}`,
		};
		appendEvent(deps.db, MINECRAFT_AGENT_ID, JSON.stringify(bootstrapEvent));
		this.agent.ensurePolling();
		deps.logger.info("[mc-brain-manager] minecraft brain started");
	}

	private stopAgent(): void {
		if (!this.agent) return;
		this.stopping = true;
		this.agent.stop();
		this.agent = undefined;
		this.deps.logger.info("[mc-brain-manager] minecraft brain stopped");
		this.stopping = false;
	}

	/** mc_session_lock の有無でエージェントの起動/停止を判断する */
	private checkLifecycleState(): void {
		if (this.stopping) return;
		try {
			const lockActive = hasSessionLock(this.deps.db);
			if (lockActive && !this.agent) {
				this.deps.logger.info("[mc-brain-manager] session lock detected, starting agent");
				this.createAgent();
			} else if (!lockActive && this.agent) {
				this.deps.logger.info("[mc-brain-manager] session lock released, stopping agent");
				this.stopAgent();
			}
		} catch (err) {
			this.deps.logger.error("[mc-brain-manager] lifecycle check error", err);
		}
	}
}
