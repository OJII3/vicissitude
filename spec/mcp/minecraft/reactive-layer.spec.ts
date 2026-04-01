/* oxlint-disable max-classes-per-file -- モック内の小クラス定義 */
import { describe, expect, mock, test } from "bun:test";
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

interface FakeFoodInfo {
	name: string;
	foodPoints: number;
	effectiveQuality: number;
	saturation: number;
}

function createFakeBot(overrides?: {
	health?: number;
	food?: number;
	entities?: Record<string, unknown>;
	inventoryItems?: { name: string; count: number }[];
	foodsByName?: Record<string, FakeFoodInfo>;
}) {
	const inventoryItems = overrides?.inventoryItems ?? [];
	const foodsByName = overrides?.foodsByName ?? {};

	// oxlint-disable-next-line prefer-event-target -- mineflayer.Bot は EventEmitter ベース
	const bot = new EventEmitter() as EventEmitter & {
		username: string;
		entity: { position: { x: number; y: number; z: number } };
		health: number;
		food: number;
		time: { timeOfDay: number };
		entities: Record<string, unknown>;
		inventory: {
			items: () => { name: string; count: number; displayName?: string }[];
			slots: unknown[];
		};
		registry: { foodsByName: Record<string, FakeFoodInfo> };
		quit: ReturnType<typeof mock>;
		respawn: ReturnType<typeof mock>;
		equip: ReturnType<typeof mock>;
		consume: ReturnType<typeof mock>;
		setControlState: ReturnType<typeof mock>;
		look: ReturnType<typeof mock>;
		clearControlStates: ReturnType<typeof mock>;
		pathfinder: { goto: ReturnType<typeof mock> };
	};
	bot.username = "test-bot";
	bot.entity = { position: { x: 0, y: 64, z: 0 } };
	bot.health = overrides?.health ?? 20;
	bot.food = overrides?.food ?? 20;
	bot.time = { timeOfDay: 0 };
	bot.entities = overrides?.entities ?? {};
	bot.inventory = {
		items: () => inventoryItems.map((i) => Object.assign({}, i)),
		slots: [],
	};
	bot.registry = { foodsByName };
	bot.quit = mock(() => {});
	bot.respawn = mock(() => {});
	bot.equip = mock(() => Promise.resolve());
	bot.consume = mock(() => Promise.resolve());
	bot.setControlState = mock(() => {});
	bot.look = mock(() => {});
	bot.clearControlStates = mock(() => {});
	bot.pathfinder = { goto: mock(() => Promise.resolve()) };
	return bot;
}

// ---------------------------------------------------------------------------
// hostile mob エンティティのヘルパー
// ---------------------------------------------------------------------------

const DEFAULT_BOT_POSITION = { x: 0, y: 64, z: 0 };

function createHostileEntity(
	name: string,
	distance: number,
	botPosition: { x: number; y: number; z: number } = DEFAULT_BOT_POSITION,
) {
	return {
		name,
		type: "mob",
		position: {
			x: botPosition.x + distance,
			y: botPosition.y,
			z: botPosition.z,
			distanceTo: (other: { x: number; y: number; z: number }) => {
				const dx = botPosition.x + distance - other.x;
				const dy = botPosition.y - other.y;
				const dz = botPosition.z - other.z;
				return Math.sqrt(dx * dx + dy * dy + dz * dz);
			},
		},
		username: undefined,
		displayName: name,
		height: 1.8,
	};
}

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
// ReactiveLayer インターフェース
// ---------------------------------------------------------------------------

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

		test("リスポーン後に reactive_respawn イベントが発行される", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({ health: 0 });
			bot.respawn.mockImplementation(() => {
				bot.health = 20;
			});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const respawnEvents = ctx.events.filter((e) => e.kind === "reactive_respawn");
			expect(respawnEvents.length).toBeGreaterThanOrEqual(1);
		});

		test("リスポーン失敗時は Brain に通知イベントが発行される", async () => {
			const ctx = createStubContext();
			const bot = createFakeBot({ health: 0 });
			// respawn を呼んでも health が回復しない
			bot.respawn.mockImplementation(() => {});
			ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);

			const layer = new ReactiveLayer(ctx);
			layer.attach();
			await layer.tick();
			layer.detach();

			const failEvents = ctx.events.filter((e) => e.kind === "reactive_respawn_failed");
			expect(failEvents.length).toBeGreaterThanOrEqual(1);
			expect(failEvents.at(0)?.importance).toBe("critical");
		});
	});

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
			bot.respawn.mockImplementation(() => {
				bot.health = 20;
			});
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

			bot.respawn.mockImplementation(() => {
				bot.health = 20;
			});

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
