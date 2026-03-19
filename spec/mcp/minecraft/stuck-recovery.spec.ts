import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type { BotContext, BotEvent } from "@vicissitude/minecraft/bot-context";
import type { ActionState } from "@vicissitude/minecraft/helpers";

// ---------------------------------------------------------------------------
// BotContext スタブ
// ---------------------------------------------------------------------------

function createStubContext(): BotContext & { events: BotEvent[] } {
	const events: BotEvent[] = [];
	let bot: unknown = null;
	const actionState: ActionState = { type: "idle" };

	return {
		events,
		getBot: () => bot as ReturnType<BotContext["getBot"]>,
		setBot: (b) => {
			bot = b;
		},
		getEvents: () => events,
		pushEvent: (kind, description, importance) => {
			events.push({
				timestamp: new Date().toISOString(),
				kind,
				description,
				importance,
			});
		},
		getActionState: () => actionState,
		setActionState: (state) => {
			Object.assign(actionState, state);
		},
	};
}

// ---------------------------------------------------------------------------
// fakeBot ファクトリ
// ---------------------------------------------------------------------------

function createFakeBot(overrides?: { health?: number }) {
	// oxlint-disable-next-line prefer-event-target -- mineflayer.Bot は EventEmitter ベース
	const bot = new EventEmitter() as EventEmitter & {
		username: string;
		entity: { position: { x: number; y: number; z: number } };
		health: number;
		food: number;
		time: { timeOfDay: number };
		quit: ReturnType<typeof mock>;
		respawn: ReturnType<typeof mock>;
		setControlState: ReturnType<typeof mock>;
		look: ReturnType<typeof mock>;
		clearControlStates: ReturnType<typeof mock>;
	};
	bot.username = "test-bot";
	bot.entity = { position: { x: 0, y: 64, z: 0 } };
	bot.health = overrides?.health ?? 20;
	bot.food = 20;
	bot.time = { timeOfDay: 0 };
	bot.quit = mock(() => {});
	bot.respawn = mock(() => {});
	bot.setControlState = mock(() => {});
	bot.look = mock(() => {});
	bot.clearControlStates = mock(() => {});
	return bot;
}

// ---------------------------------------------------------------------------
// モジュールモック
// ---------------------------------------------------------------------------

mock.module("mineflayer", () => ({
	default: { createBot: () => createFakeBot() },
}));

mock.module("mineflayer-pathfinder", () => ({
	default: { pathfinder: {} },
}));

mock.module("prismarine-viewer", () => ({
	mineflayer: () => {},
}));

// モックが確定してから動的 import する
const { respawnWithRetry, attemptStuckRecovery, _resetState } =
	await import("@vicissitude/minecraft/stuck-recovery");

beforeEach(() => {
	_resetState();
});
afterEach(() => {
	_resetState();
});

// ---------------------------------------------------------------------------
// respawnWithRetry
// ---------------------------------------------------------------------------

describe("respawnWithRetry", () => {
	test("リスポーン成功（health > 0 に回復）したら true を返す", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		// respawn() 呼び出し後に health を回復させる
		bot.respawn.mockImplementation(() => {
			bot.health = 20;
		});

		const result = await respawnWithRetry(ctx);
		expect(result).toBe(true);
		expect(bot.respawn).toHaveBeenCalled();
	});

	test("全リトライ失敗時は false を返し respawn_failed イベントが発行される", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		// respawn() を呼んでも health が回復しない
		bot.respawn.mockImplementation(() => {});

		const result = await respawnWithRetry(ctx);
		expect(result).toBe(false);

		const failEvents = ctx.events.filter((e) => e.kind === "respawn_failed");
		expect(failEvents.length).toBeGreaterThanOrEqual(1);
	});

	test("bot が null の場合は false を返す", async () => {
		const ctx = createStubContext();
		// bot は null（setBot していない）

		const result = await respawnWithRetry(ctx);
		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// attemptStuckRecovery
// ---------------------------------------------------------------------------

describe("attemptStuckRecovery", () => {
	test("health <= 0 のとき、まずリスポーンリトライを実行する", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		bot.respawn.mockImplementation(() => {
			bot.health = 20;
		});

		const result = await attemptStuckRecovery({ ctx });
		expect(result).toBe(true);
		expect(bot.respawn).toHaveBeenCalled();
	});

	test("リスポーン成功したらそこで終了し true を返す（ランダム移動には進まない）", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		bot.respawn.mockImplementation(() => {
			bot.health = 20;
		});

		const result = await attemptStuckRecovery({ ctx });
		expect(result).toBe(true);
		// ランダム移動（setControlState）は呼ばれない
		expect(bot.setControlState).not.toHaveBeenCalled();
	});

	test("リスポーン不要（health > 0）のとき、ランダム移動を試みる", async () => {
		const bot = createFakeBot({ health: 10 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		// ランダム移動中に位置が変わったことにする
		const originalX = bot.entity.position.x;
		bot.setControlState.mockImplementation(() => {
			bot.entity.position.x = originalX + 5;
			bot.entity.position.z += 3;
		});

		await attemptStuckRecovery({ ctx });
		// リスポーンは呼ばれない
		expect(bot.respawn).not.toHaveBeenCalled();
		// ランダム移動が試みられた
		expect(bot.setControlState).toHaveBeenCalled();
	});

	test("ランダム移動後に位置が変化したら true を返す", async () => {
		const bot = createFakeBot({ health: 10 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		bot.setControlState.mockImplementation(() => {
			bot.entity.position.x += 10;
		});

		const result = await attemptStuckRecovery({ ctx });
		expect(result).toBe(true);
	});

	test("全段階失敗したら reconnect をトリガーし false を返す", async () => {
		const bot = createFakeBot({ health: 10 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		// 移動しても位置が変わらない（スタック継続）
		bot.setControlState.mockImplementation(() => {});

		const reconnectFn = mock(() => {});
		const result = await attemptStuckRecovery({ ctx, reconnect: reconnectFn });
		expect(result).toBe(false);
		expect(reconnectFn).toHaveBeenCalled();
	});

	test("復帰成功時に onRecoverySuccess コールバックが呼ばれる", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		bot.respawn.mockImplementation(() => {
			bot.health = 20;
		});

		const onSuccess = mock(() => {});
		const result = await attemptStuckRecovery({ ctx, onRecoverySuccess: onSuccess });
		expect(result).toBe(true);
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	test("復帰中に再度呼び出された場合は false を返す（二重実行防止）", async () => {
		const bot = createFakeBot({ health: 10 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		// 移動しても位置が変わらない（復帰に時間がかかる）
		bot.setControlState.mockImplementation(() => {});

		const reconnectFn = mock(() => {});
		// 1回目の復帰を開始（完了を待たない）
		const first = attemptStuckRecovery({ ctx, reconnect: reconnectFn });
		// 2回目の復帰は即座に false を返す
		const second = await attemptStuckRecovery({ ctx, reconnect: reconnectFn });
		expect(second).toBe(false);

		// 1回目を待ってクリーンアップ
		await first;
	});

	test("クールダウン期間内の再実行はスキップされる", async () => {
		const bot = createFakeBot({ health: 0 });
		const ctx = createStubContext();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

		bot.respawn.mockImplementation(() => {
			bot.health = 20;
		});

		// 1回目: 成功
		const result1 = await attemptStuckRecovery({ ctx, cooldownMs: 300_000 });
		expect(result1).toBe(true);

		// 体力を0に戻して再スタック
		bot.health = 0;

		// 2回目: クールダウン中なのでスキップ（false）
		const result2 = await attemptStuckRecovery({ ctx, cooldownMs: 300_000 });
		expect(result2).toBe(false);
		// respawn は1回目の時だけ呼ばれた
		expect(bot.respawn).toHaveBeenCalledTimes(1);
	});
});
