/* oxlint-disable max-classes-per-file -- モック内の小クラス定義 */
import { describe, expect, mock, test } from "bun:test";

import type { BotContext } from "@vicissitude/minecraft/bot-context";
import type { ActionState } from "@vicissitude/minecraft/helpers";

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
// ReactiveLayer インターフェース（後半）
// ---------------------------------------------------------------------------

describe("ReactiveLayer", () => {
	// =======================================================================
	// 優先順位: リスポーン > 逃走 > 食事
	// =======================================================================

	describe("反射の優先順位", () => {
		test("hostile mob 接近中かつ空腹のとき、逃走が食事より優先される", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 4,
				food: 3,
				entities: { "entity-1": zombie },
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

			// 逃走イベントが先に発行されること
			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents.length).toBeGreaterThanOrEqual(1);

			// 同一 tick 内で食事は実行されない（逃走が優先）
			const eatEvents = ctx.events.filter((e) => e.kind === "reactive_eat");
			expect(eatEvents).toHaveLength(0);
		});

		test("死亡時（health <= 0）は逃走や食事より先にリスポーンされる", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 0,
				food: 3,
				entities: { "entity-1": zombie },
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
			// respawn() はパケット送信のみ — health は同期更新されない
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			// リスポーンが実行されること
			expect(bot.respawn).toHaveBeenCalled();
		});
	});

	// =======================================================================
	// Brain（MCP ツール）との競合制御
	// =======================================================================

	describe("Brain との競合制御", () => {
		test("Brain ジョブ実行中に hostile mob 接近 → ジョブをキャンセルして逃走する", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
			// Brain がジョブ実行中
			ctx.setActionState({ type: "collecting", target: "diamond_ore" });

			const cancelFn = mock(() => {});
			const layer = new ReactiveLayer(ctx, { onCancelJob: cancelFn });
			layer.attach();
			await layer.tick();
			layer.detach();

			// ジョブがキャンセルされること
			expect(cancelFn).toHaveBeenCalled();
			// 逃走が実行されること
			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("Brain ジョブ実行中に食事が必要 → ジョブをキャンセルして食事する", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 4,
				food: 3,
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
			ctx.setActionState({ type: "collecting", target: "diamond_ore" });

			const cancelFn = mock(() => {});
			const layer = new ReactiveLayer(ctx, { onCancelJob: cancelFn });
			layer.attach();
			await layer.tick();
			layer.detach();

			expect(cancelFn).toHaveBeenCalled();
			const eatEvents = ctx.events.filter((e) => e.kind === "reactive_eat");
			expect(eatEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("ActionState が idle のときは onCancelJob が呼ばれない", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
			// idle 状態

			const cancelFn = mock(() => {});
			const layer = new ReactiveLayer(ctx, { onCancelJob: cancelFn });
			layer.attach();
			await layer.tick();
			layer.detach();

			expect(cancelFn).not.toHaveBeenCalled();
			// 逃走は実行される
			const fleeEvents = ctx.events.filter((e) => e.kind === "reactive_flee");
			expect(fleeEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("死亡時は ActionState に関係なくリスポーンが実行される", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({ health: 0 });
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
			// Brain がジョブ実行中でも
			ctx.setActionState({ type: "collecting", target: "diamond_ore" });

			// respawn() はパケット送信のみ — health は同期更新されない

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			expect(bot.respawn).toHaveBeenCalled();
		});

		test("reactive 実行中は ActionState が更新される", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			// pathfinder.goto の実行中に ActionState を確認する
			let actionStateDuringFlee: ActionState | null = null;
			bot.pathfinder.goto = mock(() => {
				actionStateDuringFlee = { ...ctx.getActionState() };
				return Promise.resolve();
			});

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			expect(actionStateDuringFlee).not.toBeNull();
			expect((actionStateDuringFlee as unknown as ActionState).type).toBe("fleeing");
		});

		test("reactive アクション完了後に ActionState が idle に戻る", async () => {
			const zombie = createHostileEntity("zombie", 5);
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

			expect(ctx.getActionState().type).toBe("idle");
		});
	});

	// =======================================================================
	// スロットリング
	// =======================================================================

	describe("スロットリング", () => {
		test("hostile mob スキャンが指定間隔より短い間隔で実行されない", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			// scanIntervalMs を非常に大きくして 2回目の tick ではスキャンされないようにする
			const layer = new ReactiveLayer(ctx, { scanIntervalMs: 60_000 });
			layer.attach();

			await layer.tick();
			const firstFleeCount = ctx.events.filter((e) => e.kind === "reactive_flee").length;

			// 即座に 2回目の tick — スロットリングで hostile mob スキャンはスキップ
			await layer.tick();
			const secondFleeCount = ctx.events.filter((e) => e.kind === "reactive_flee").length;

			layer.detach();

			// 1回目で逃走が発行され、2回目ではスキャンがスキップされるため増えない
			expect(firstFleeCount).toBeGreaterThanOrEqual(1);
			expect(secondFleeCount).toBe(firstFleeCount);
		});

		test("指定間隔経過後は再度スキャンが実行される", async () => {
			const zombie = createHostileEntity("zombie", 5);
			const ctx = createStubContext();
			const bot = createFakeBot({
				health: 20,
				entities: { "entity-1": zombie },
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			// scanIntervalMs を 0 にして毎回スキャンさせる
			const layer = new ReactiveLayer(ctx, { scanIntervalMs: 0 });
			layer.attach();

			await layer.tick();
			const firstFleeCount = ctx.events.filter((e) => e.kind === "reactive_flee").length;

			await layer.tick();
			const secondFleeCount = ctx.events.filter((e) => e.kind === "reactive_flee").length;

			layer.detach();

			// 両方の tick でスキャンが実行される
			expect(firstFleeCount).toBeGreaterThanOrEqual(1);
			expect(secondFleeCount).toBeGreaterThan(firstFleeCount);
		});
	});

	// =======================================================================
	// bot が null の場合
	// =======================================================================

	describe("bot が未接続の場合", () => {
		test("bot が null のとき tick は何もしない（エラーにならない）", async () => {
			const ctx = createStubContext();
			// bot を set しない

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			expect(ctx.events).toHaveLength(0);
		});
	});
});
