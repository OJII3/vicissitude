/* oxlint-disable max-classes-per-file -- モック内の小クラス定義 */
import { describe, expect, mock, test } from "bun:test";

import type { BotContext } from "@vicissitude/minecraft/bot-context";

import { createFakeBot, createHostileEntity, createStubContext } from "./reactive-layer-helpers.ts";

// ---------------------------------------------------------------------------
// モジュールモック
// ---------------------------------------------------------------------------

void mock.module("mineflayer", () => ({
	default: { createBot: () => createFakeBot() },
}));

void mock.module("mineflayer-pathfinder", () => ({
	default: {
		pathfinder: {},
		goals: {
			GoalInvert: class {
				constructor(public goal: unknown) {}
			},
			GoalFollow: class {
				constructor(
					public entity: unknown,
					public distance: number,
				) {}
			},
		},
	},
}));

void mock.module("prismarine-viewer", () => ({
	mineflayer: () => {},
}));

// モックが確定してから動的 import する
const { ReactiveLayer } = await import("@vicissitude/minecraft/reactive-layer");

// ---------------------------------------------------------------------------
// ReactiveLayer インターフェース（前半）
//
// 後半のテスト（優先順位、Brain 競合制御、スロットリング、bot 未接続）は
// reactive-layer-advanced.spec.ts に分割されている。
// ---------------------------------------------------------------------------

// oxlint-disable-next-line max-lines-per-function -- テストスイート全体を1つの describe にまとめる設計
describe("ReactiveLayer", () => {
	// =======================================================================
	// ライフサイクル: attach / detach
	// =======================================================================

	describe("attach / detach", () => {
		test("attach() で tick ループが開始される", () => {
			const ctx = createStubContext();
			const bot = createFakeBot();
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();

			expect(layer.isAttached()).toBe(true);
		});

		test("detach() で tick ループが停止される", () => {
			const ctx = createStubContext();
			const bot = createFakeBot();
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			layer.detach();

			expect(layer.isAttached()).toBe(false);
		});

		test("二重 attach は無視される（エラーにならない）", () => {
			const ctx = createStubContext();
			const bot = createFakeBot();
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			// 二重呼び出し
			layer.attach();

			expect(layer.isAttached()).toBe(true);
		});

		test("detach 後に再度 attach できる", () => {
			const ctx = createStubContext();
			const bot = createFakeBot();
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			layer.detach();
			layer.attach();

			expect(layer.isAttached()).toBe(true);
		});

		test("attach 前の detach は無視される（エラーにならない）", () => {
			const ctx = createStubContext();
			const layer = new ReactiveLayer(ctx);

			// 例外が投げられないことを検証
			expect(() => layer.detach()).not.toThrow();
		});
	});

	// =======================================================================
	// 反射ルール 1: 危険mob接近 → 逃走
	// =======================================================================

	describe("逃走反射", () => {
		test("hostile mob が近距離にいると flee イベントが発行される", async () => {
			const zombie = createHostileEntity("zombie", 8);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("hostile mob が遠距離にいる場合は逃走しない", async () => {
			const zombie = createHostileEntity("zombie", 100);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents).toHaveLength(0);
		});

		test("passive mob（cow 等）には反応しない", async () => {
			const cow = {
				name: "cow",
				type: "mob",
				position: {
					x: 3,
					y: 64,
					z: 0,
					distanceTo: () => 3,
				},
				username: undefined,
				displayName: "cow",
				height: 1.4,
			};
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": cow },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents).toHaveLength(0);
		});

		test("逃走失敗時は Brain に通知イベントが発行される", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			// pathfinder.goto を失敗させる
			bot.pathfinder.goto = mock(() => Promise.reject(new Error("pathfinding failed")));
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const failEvents = ctx.events.filter((e) => e.kind === "reactive_flee_failed");
			expect(failEvents.length).toBeGreaterThanOrEqual(1);
			expect(failEvents.at(0)?.importance).toBe("high");
		});

		test("creeper が 16 ブロック以内にいる場合は逃走がトリガーされる", async () => {
			const creeper = createHostileEntity("creeper", 15);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": creeper },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("creeper が 16 ブロックより遠くにいる場合は逃走しない", async () => {
			const creeper = createHostileEntity("creeper", 17);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": creeper },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents).toHaveLength(0);
		});

		test("warden が 16 ブロック以内にいる場合は逃走がトリガーされる", async () => {
			const warden = createHostileEntity("warden", 15);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": warden },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("zombie が 8 ブロックより遠く 16 ブロック以内にいる場合は逃走しない（8 ブロック閾値の確認）", async () => {
			const zombie = createHostileEntity("zombie", 12);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents).toHaveLength(0);
		});
	});

	// =======================================================================
	// 反射ルール 2: 体力/空腹低い & 食料あり → 自動食事
	// =======================================================================

	describe("自動食事反射", () => {
		test("空腹度が低く食料を持っていると食事イベントが発行される", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				food: 6,
				inventoryItems: [{ name: "cooked_beef", count: 5 }],
				foodsByName: {
					cooked_beef: {
						name: "cooked_beef",
						foodPoints: 8,
						effectiveQuality: 12.8,
						saturation: 12.8,
					},
				},
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const eatEvents = ctx.events.filter((e) => e.kind === "reactive_eat");
			expect(eatEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("体力が低く食料を持っていると食事イベントが発行される", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 4,
				food: 10,
				inventoryItems: [{ name: "cooked_beef", count: 3 }],
				foodsByName: {
					cooked_beef: {
						name: "cooked_beef",
						foodPoints: 8,
						effectiveQuality: 12.8,
						saturation: 12.8,
					},
				},
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const eatEvents = ctx.events.filter((e) => e.kind === "reactive_eat");
			expect(eatEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("空腹度・体力が十分な場合は食事しない", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				food: 20,
				inventoryItems: [{ name: "cooked_beef", count: 5 }],
				foodsByName: {
					cooked_beef: {
						name: "cooked_beef",
						foodPoints: 8,
						effectiveQuality: 12.8,
						saturation: 12.8,
					},
				},
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const eatEvents = ctx.events.filter((e) => e.kind === "reactive_eat");
			expect(eatEvents).toHaveLength(0);
		});

		test("食料がない場合は Brain に通知イベントが発行される", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 4,
				food: 3,
				// 食料なし
				inventoryItems: [],
				foodsByName: {},
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const noFoodEvents = ctx.events.filter((e) => e.kind === "reactive_no_food");
			expect(noFoodEvents.length).toBeGreaterThanOrEqual(1);
			expect(noFoodEvents.at(0)?.importance).toBe("high");
		});
	});

	// =======================================================================
	// 反射ルール 3: 死亡 → 自動リスポーン
	// =======================================================================

	describe("自動リスポーン反射", () => {
		test("health が 0 以下のとき respawn が呼ばれる", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({ health: 0 });
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			expect(bot.respawn).toHaveBeenCalled();
		});

		test("respawn() が例外を投げなければ reactive_respawn イベントが発行される", async () => {
			const ctx = createStubContext();
			// respawn() はパケット送信のみ — health は同期更新されない
			const bot = createFakeBot({ health: 0 });
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			// health が 0 のままでも、例外なく respawn() が完了すれば成功
			const respawnEvents = ctx.events.filter((e) => e.kind === "reactive_respawn");
			expect(respawnEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("respawn() が例外をスローした場合は失敗イベントが発行される", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({ health: 0 });
			bot.respawn.mockImplementation(() => {
				throw new Error("respawn failed");
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const failEvents = ctx.events.filter((e) => e.kind === "reactive_respawn_failed");
			expect(failEvents.length).toBeGreaterThanOrEqual(1);
			expect(failEvents.at(0)?.importance).toBe("critical");
		});

		test("リスポーン要求中は重複呼び出しされない", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({ health: 0 });
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();

			// 1回目の tick — respawn が呼ばれる
			await layer.tick();
			expect(bot.respawn).toHaveBeenCalledTimes(1);

			// 2回目の tick — まだ spawn イベントが来ていないので重複呼び出しされない
			await layer.tick();
			expect(bot.respawn).toHaveBeenCalledTimes(1);

			layer.detach();
		});

		test("spawn イベント後にリスポーンフラグがリセットされる", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({ health: 0 });
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();

			// 1回目の tick — respawn 呼び出し
			await layer.tick();
			expect(bot.respawn).toHaveBeenCalledTimes(1);

			// spawn イベント発火 → フラグリセット
			bot.health = 20;
			bot.emit("spawn");

			// 再度死亡
			bot.health = 0;

			// 3回目の tick — フラグがリセットされたので再度 respawn が呼ばれる
			await layer.tick();
			expect(bot.respawn).toHaveBeenCalledTimes(2);

			layer.detach();
		});
	});
});
