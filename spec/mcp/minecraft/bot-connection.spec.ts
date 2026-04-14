import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type { BotContext, BotEvent } from "@vicissitude/minecraft/bot-context";
import type { ActionState } from "@vicissitude/minecraft/helpers";

// ---------------------------------------------------------------------------
// mineflayer モジュールモック
//
// createBotConnection → initBot → mineflayer.createBot を差し替え、
// EventEmitter ベースの偽 Bot を返す。
// ---------------------------------------------------------------------------

/** テストごとにリセットする偽 Bot */
let fakeBot: EventEmitter & {
	username: string;
	entity: { position: { x: number; y: number; z: number } };
	health: number;
	food: number;
	time: { timeOfDay: number };
	quit: ReturnType<typeof mock>;
	respawn: ReturnType<typeof mock>;
	loadPlugin: ReturnType<typeof mock>;
	removeAllListeners: ReturnType<typeof mock>;
};

function createFakeBot() {
	// oxlint-disable-next-line prefer-event-target -- mineflayer.Bot は EventEmitter ベース
	const bot = new EventEmitter() as typeof fakeBot;
	bot.username = "test-bot";
	bot.entity = { position: { x: 0, y: 64, z: 0 } };
	bot.health = 20;
	bot.food = 20;
	bot.time = { timeOfDay: 0 };
	bot.quit = mock(() => {});
	bot.respawn = mock(() => {});
	bot.loadPlugin = mock(() => {});
	// removeAllListeners は EventEmitter 由来だが、spy で呼び出し検知できるように上書き
	const originalRemoveAll = bot.removeAllListeners.bind(bot);
	bot.removeAllListeners = mock((...args: Parameters<typeof bot.removeAllListeners>) => {
		// oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-return -- EventEmitter の型を透過的に渡す
		return originalRemoveAll(...args);
	});
	return bot;
}

void mock.module("mineflayer", () => ({
	default: {
		createBot: () => fakeBot,
	},
}));

// pathfinder プラグイン — loadPlugin で渡されるだけなのでスタブ
void mock.module("mineflayer-pathfinder", () => ({
	default: { pathfinder: {} },
}));

// prismarine-viewer — startViewer 内で呼ばれるのでスタブ
void mock.module("prismarine-viewer", () => ({
	mineflayer: () => {},
}));

// モックが確定してから動的 import する
const { createBotConnection } = await import("@vicissitude/minecraft/bot-connection");

const { stubLogger } = await import("./stub-logger.ts");

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
// テスト
// ---------------------------------------------------------------------------

describe("bot-connection — death イベントハンドラ", () => {
	let ctx: ReturnType<typeof createStubContext>;
	let conn: ReturnType<typeof createBotConnection>;

	afterEach(() => {
		conn?.shutdown();
	});

	function setup() {
		fakeBot = createFakeBot();
		ctx = createStubContext();
		conn = createBotConnection(
			{
				host: "localhost",
				port: 25565,
				username: "test-bot",
				version: undefined,
				authMode: "offline",
				profilesFolder: undefined,
				viewerPort: 0,
			},
			ctx,
			stubLogger,
		);
		conn.start();
		// spawn を先に発火して内部状態を初期化する
		fakeBot.emit("spawn");
	}

	test("death イベント発火時に ctx.pushEvent('death', ...) が呼ばれる", () => {
		setup();
		fakeBot.emit("death");

		const deathEvents = ctx.events.filter((e) => e.kind === "death");
		expect(deathEvents).toHaveLength(1);
		expect(deathEvents[0]?.description).toBe("Bot died");
		expect(deathEvents[0]?.importance).toBe("high");
	});

	// respawn は ReactiveLayer の tick インターバルで処理 (reactive-layer.spec.ts)

	test("shutdown 後に start を呼ぶと再接続できる", () => {
		fakeBot = createFakeBot();
		ctx = createStubContext();
		conn = createBotConnection(
			{
				host: "localhost",
				port: 25565,
				username: "test-bot",
				version: undefined,
				authMode: "offline",
				profilesFolder: undefined,
				viewerPort: 0,
			},
			ctx,
			stubLogger,
		);

		// 1. start → spawn → bot が存在する
		conn.start();
		fakeBot.emit("spawn");
		expect(ctx.getBot()).not.toBeNull();

		// 2. shutdown → bot がクリーンアップされる
		conn.shutdown();
		expect(ctx.getBot()).toBeNull();

		// 3. 新しい fakeBot を用意して再度 start
		fakeBot = createFakeBot();
		conn.start();
		fakeBot.emit("spawn");

		// 再接続後に bot が存在し、イベントを受信できる
		expect(ctx.getBot()).not.toBeNull();
		fakeBot.emit("death");
		const deathEvents = ctx.events.filter((e) => e.kind === "death");
		expect(deathEvents.length).toBeGreaterThanOrEqual(1);
	});

	// 死亡ループ防止は ReactiveLayer の tick インターバルで代替 (reactive-layer.spec.ts)
});
