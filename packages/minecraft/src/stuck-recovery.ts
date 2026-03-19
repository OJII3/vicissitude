import type { BotContext } from "./bot-context.ts";

export interface StuckRecoveryOptions {
	ctx: BotContext;
	reconnect?: () => void;
	onRecoverySuccess?: () => void;
	requestSessionRotation?: () => Promise<void>;
	cooldownMs?: number;
	/** ランダム移動の待機時間（テスト用にオーバーライド可能） */
	walkDurationMs?: number;
	/** リスポーン待機時間（テスト用にオーバーライド可能） */
	respawnWaitMs?: number;
}

const RESPAWN_MAX_RETRIES = 3;
const RESPAWN_WAIT_MS = 100;
const DEFAULT_COOLDOWN_MS = 0;
const DEFAULT_WALK_DURATION_MS = 3_000;
const MOVE_THRESHOLD = 3;

let isRecovering = false;
let lastRecoveryAt = 0;

/** テスト用: モジュールレベルの状態をリセットする */
export function _resetState(): void {
	isRecovering = false;
	lastRecoveryAt = 0;
}

export async function respawnWithRetry(
	ctx: BotContext,
	waitMs: number = RESPAWN_WAIT_MS,
): Promise<boolean> {
	const bot = ctx.getBot();
	if (!bot) return false;
	if (bot.health > 0) return true;

	for (let i = 0; i < RESPAWN_MAX_RETRIES; i++) {
		bot.respawn();
		// oxlint-disable-next-line no-await-in-loop -- sequential retry: each attempt must complete before checking health
		await new Promise<void>((resolve) => {
			setTimeout(resolve, waitMs);
		});
		if (bot.health > 0) return true;
	}

	ctx.pushEvent("respawn_failed", "リスポーン失敗: 3回試行", "critical");
	return false;
}

export async function attemptStuckRecovery(options: StuckRecoveryOptions): Promise<boolean> {
	const {
		ctx,
		reconnect,
		onRecoverySuccess,
		requestSessionRotation,
		cooldownMs = DEFAULT_COOLDOWN_MS,
		walkDurationMs = DEFAULT_WALK_DURATION_MS,
		respawnWaitMs = RESPAWN_WAIT_MS,
	} = options;

	if (isRecovering) return false;

	const now = Date.now();
	if (cooldownMs > 0 && lastRecoveryAt > 0 && now - lastRecoveryAt < cooldownMs) return false;

	isRecovering = true;
	try {
		const bot = ctx.getBot();
		if (!bot) return false;

		const markRecovery = () => {
			if (cooldownMs > 0) lastRecoveryAt = Date.now();
		};

		// 段階1: リスポーン
		if (bot.health <= 0) {
			const ok = await respawnWithRetry(ctx, respawnWaitMs);
			if (ok) {
				markRecovery();
				onRecoverySuccess?.();
				void requestSessionRotation?.();
				return true;
			}
			// リスポーン失敗 → 段階3 へ
			reconnect?.();
			markRecovery();
			void requestSessionRotation?.();
			return false;
		}

		// 段階2: ランダム移動
		const before = { x: bot.entity.position.x, z: bot.entity.position.z };
		const randomYaw = Math.random() * Math.PI * 2 - Math.PI;
		bot.look(randomYaw, 0);
		bot.setControlState("forward", true);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, walkDurationMs);
		});
		bot.clearControlStates();

		const dx = bot.entity.position.x - before.x;
		const dz = bot.entity.position.z - before.z;
		const distance = Math.sqrt(dx * dx + dz * dz);

		if (distance >= MOVE_THRESHOLD) {
			markRecovery();
			onRecoverySuccess?.();
			void requestSessionRotation?.();
			return true;
		}

		// 段階3: reconnect
		reconnect?.();
		markRecovery();
		void requestSessionRotation?.();
		return false;
	} finally {
		isRecovering = false;
	}
}
