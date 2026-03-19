import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { BotContext } from "./bot-context.ts";
import { _resetState, attemptStuckRecovery, respawnWithRetry } from "./stuck-recovery.ts";

function createFakeBot(overrides: { health?: number; position?: { x: number; z: number } } = {}) {
	// oxlint-disable-next-line prefer-event-target -- mineflayer.Bot extends EventEmitter, not EventTarget
	const bot = new EventEmitter() as EventEmitter & {
		health: number;
		entity: { position: { x: number; z: number } };
		respawn: ReturnType<typeof mock>;
		look: ReturnType<typeof mock>;
		setControlState: ReturnType<typeof mock>;
		clearControlStates: ReturnType<typeof mock>;
	};
	bot.health = overrides.health ?? 20;
	bot.entity = { position: { x: overrides.position?.x ?? 0, z: overrides.position?.z ?? 0 } };
	bot.respawn = mock(() => {});
	bot.look = mock(() => {});
	bot.setControlState = mock(() => {});
	bot.clearControlStates = mock(() => {});
	return bot;
}

type FakeBot = ReturnType<typeof createFakeBot>;

function createFakeCtx(bot: FakeBot | null = null): BotContext {
	return {
		getBot: () => bot as never,
		setBot: mock(() => {}),
		getEvents: () => [],
		pushEvent: mock(() => {}),
		getActionState: () => ({ type: "idle" as const }),
		setActionState: mock(() => {}),
	};
}

beforeEach(() => {
	_resetState();
});

afterEach(() => {
	_resetState();
});

describe("respawnWithRetry", () => {
	test("bot が null なら false を返す", async () => {
		const ctx = createFakeCtx(null);
		expect(await respawnWithRetry(ctx)).toBe(false);
	});

	test("health > 0 なら respawn を呼ばず true を返す", async () => {
		const bot = createFakeBot({ health: 10 });
		const ctx = createFakeCtx(bot);
		expect(await respawnWithRetry(ctx)).toBe(true);
		expect(bot.respawn).toHaveBeenCalledTimes(0);
	});

	test("1回目の respawn で health が回復すれば 1回だけ呼ばれる", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createFakeCtx(bot);
		bot.respawn = mock(() => {
			bot.health = 20;
		});
		expect(await respawnWithRetry(ctx)).toBe(true);
		expect(bot.respawn).toHaveBeenCalledTimes(1);
	});

	test("3回失敗したら false を返し respawn_failed イベントを発行する", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createFakeCtx(bot);
		expect(await respawnWithRetry(ctx)).toBe(false);
		expect(bot.respawn).toHaveBeenCalledTimes(3);
		expect(ctx.pushEvent).toHaveBeenCalledWith("respawn_failed", expect.any(String), "critical");
	});

	test("2回目で health が回復した場合は早期終了する", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createFakeCtx(bot);
		let callCount = 0;
		bot.respawn = mock(() => {
			callCount += 1;
			if (callCount === 2) bot.health = 20;
		});
		expect(await respawnWithRetry(ctx)).toBe(true);
		expect(bot.respawn).toHaveBeenCalledTimes(2);
	});
});

describe("attemptStuckRecovery", () => {
	test("isRecovering フラグで再入を防止する", async () => {
		const bot = createFakeBot({ health: 20 });
		const ctx = createFakeCtx(bot);

		// 1回目の呼び出しで移動させる（長めにブロックして再入テスト）
		const firstCall = attemptStuckRecovery({ ctx, walkDurationMs: 0 });
		// 2回目は即座に false を返すべき
		const secondResult = await attemptStuckRecovery({ ctx, walkDurationMs: 0 });
		expect(secondResult).toBe(false);

		await firstCall;
	});

	test("cooldownMs 以内の連続呼び出しは false を返す", async () => {
		const bot = createFakeBot({ health: 20, position: { x: 0, z: 0 } });
		const ctx = createFakeCtx(bot);

		// 1回目: 移動距離 >= 3 で成功させる
		bot.clearControlStates = mock(() => {
			bot.entity.position.x = 10;
			bot.entity.position.z = 10;
		});
		const first = await attemptStuckRecovery({ ctx, cooldownMs: 60_000, walkDurationMs: 0 });
		expect(first).toBe(true);

		// 2回目: cooldown 内なので false
		bot.entity.position.x = 0;
		bot.entity.position.z = 0;
		const second = await attemptStuckRecovery({ ctx, cooldownMs: 60_000, walkDurationMs: 0 });
		expect(second).toBe(false);
	});

	test("ランダム移動: look, setControlState, clearControlStates の呼び出し順", async () => {
		const bot = createFakeBot({ health: 20 });
		const ctx = createFakeCtx(bot);
		const callOrder: string[] = [];
		bot.look = mock(() => {
			callOrder.push("look");
		});
		bot.setControlState = mock(() => {
			callOrder.push("setControlState");
		});
		bot.clearControlStates = mock(() => {
			callOrder.push("clearControlStates");
		});

		await attemptStuckRecovery({ ctx, walkDurationMs: 0 });

		expect(callOrder).toEqual(["look", "setControlState", "clearControlStates"]);
		expect(bot.look).toHaveBeenCalledTimes(1);
		// yaw は [-PI, PI) の範囲
		const firstCall = bot.look.mock.calls[0];
		const yaw = (firstCall ? firstCall[0] : undefined) as number;
		expect(yaw).toBeGreaterThanOrEqual(-Math.PI);
		expect(yaw).toBeLessThan(Math.PI);
		expect(bot.setControlState).toHaveBeenCalledWith("forward", true);
	});

	test("MOVE_THRESHOLD (3) 未満の移動は失敗と判定される", async () => {
		const bot = createFakeBot({ health: 20, position: { x: 0, z: 0 } });
		const ctx = createFakeCtx(bot);
		// 移動距離 2 < 3
		bot.clearControlStates = mock(() => {
			bot.entity.position.x = 1;
			bot.entity.position.z = 1;
		});

		const result = await attemptStuckRecovery({ ctx, walkDurationMs: 0 });
		expect(result).toBe(false);
	});

	test("MOVE_THRESHOLD 以上の移動は成功と判定される", async () => {
		const bot = createFakeBot({ health: 20, position: { x: 0, z: 0 } });
		const ctx = createFakeCtx(bot);
		bot.clearControlStates = mock(() => {
			bot.entity.position.x = 3;
			bot.entity.position.z = 3;
		});

		const result = await attemptStuckRecovery({ ctx, walkDurationMs: 0 });
		expect(result).toBe(true);
	});

	test("移動成功時に onRecoverySuccess が呼ばれる", async () => {
		const bot = createFakeBot({ health: 20, position: { x: 0, z: 0 } });
		const ctx = createFakeCtx(bot);
		const onRecoverySuccess = mock(() => {});
		bot.clearControlStates = mock(() => {
			bot.entity.position.x = 10;
		});

		await attemptStuckRecovery({ ctx, onRecoverySuccess, walkDurationMs: 0 });
		expect(onRecoverySuccess).toHaveBeenCalledTimes(1);
	});

	test("移動失敗時に reconnect が呼ばれる", async () => {
		const bot = createFakeBot({ health: 20, position: { x: 0, z: 0 } });
		const ctx = createFakeCtx(bot);
		const reconnect = mock(() => {});

		await attemptStuckRecovery({ ctx, reconnect, walkDurationMs: 0 });
		expect(reconnect).toHaveBeenCalledTimes(1);
	});

	test("reconnect が undefined でもクラッシュしない", async () => {
		const bot = createFakeBot({ health: 20, position: { x: 0, z: 0 } });
		const ctx = createFakeCtx(bot);

		// reconnect を渡さない
		const result = await attemptStuckRecovery({ ctx, walkDurationMs: 0 });
		expect(result).toBe(false);
	});

	test("bot が null なら false を返す", async () => {
		const ctx = createFakeCtx(null);
		const result = await attemptStuckRecovery({ ctx, walkDurationMs: 0 });
		expect(result).toBe(false);
	});

	test("health <= 0 でリスポーン成功なら onRecoverySuccess が呼ばれ true を返す", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createFakeCtx(bot);
		const onRecoverySuccess = mock(() => {});
		bot.respawn = mock(() => {
			bot.health = 20;
		});

		const result = await attemptStuckRecovery({ ctx, onRecoverySuccess, walkDurationMs: 0 });
		expect(result).toBe(true);
		expect(onRecoverySuccess).toHaveBeenCalledTimes(1);
	});

	test("health <= 0 でリスポーン失敗なら reconnect が呼ばれ false を返す", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createFakeCtx(bot);
		const reconnect = mock(() => {});

		const result = await attemptStuckRecovery({ ctx, reconnect, walkDurationMs: 0 });
		expect(result).toBe(false);
		expect(reconnect).toHaveBeenCalledTimes(1);
	});

	test("_resetState() でモジュール状態がリセットされる", async () => {
		const bot = createFakeBot({ health: 20, position: { x: 0, z: 0 } });
		const ctx = createFakeCtx(bot);
		bot.clearControlStates = mock(() => {
			bot.entity.position.x = 10;
		});

		// cooldownMs 付きで1回実行
		await attemptStuckRecovery({ ctx, cooldownMs: 60_000, walkDurationMs: 0 });

		// リセットせずにもう一度 → cooldown で弾かれる
		bot.entity.position.x = 0;
		const beforeReset = await attemptStuckRecovery({ ctx, cooldownMs: 60_000, walkDurationMs: 0 });
		expect(beforeReset).toBe(false);

		// リセット後 → 通るようになる
		_resetState();
		bot.clearControlStates = mock(() => {
			bot.entity.position.x = 10;
		});
		const afterReset = await attemptStuckRecovery({ ctx, cooldownMs: 60_000, walkDurationMs: 0 });
		expect(afterReset).toBe(true);
	});
});
