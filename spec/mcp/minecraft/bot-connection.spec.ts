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
	bot.removeAllListeners = mock((...args: Parameters<typeof bot.removeAllListeners>) =>
		originalRemoveAll(...args),
	);
	return bot;
}

mock.module("mineflayer", () => ({
	default: {
		createBot: () => fakeBot,
	},
}));

// pathfinder プラグイン — loadPlugin で渡されるだけなのでスタブ
mock.module("mineflayer-pathfinder", () => ({
	default: { pathfinder: {} },
}));

// prismarine-viewer — startViewer 内で呼ばれるのでスタブ
mock.module("prismarine-viewer", () => ({
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

	test("death イベント発火時に bot.respawn() が呼ばれる", () => {
		setup();
		fakeBot.emit("death");

		expect(fakeBot.respawn).toHaveBeenCalledTimes(1);
	});

	test("death イベントが複数回発火した場合、クールダウンにより連続 respawn がスキップされる", () => {
		setup();
		// 同期的に3回 death を発火 → クールダウン(1秒)により respawn は1回目のみ
		fakeBot.emit("death");
		fakeBot.emit("death");
		fakeBot.emit("death");

		expect(fakeBot.respawn).toHaveBeenCalledTimes(1);
		// pushEvent("death", ...) はクールダウンに関係なく毎回呼ばれる
		const deathEvents = ctx.events.filter((e) => e.kind === "death");
		expect(deathEvents).toHaveLength(3);
	});

	test("respawn() が例外を投げてもクラッシュしない", () => {
		setup();
		fakeBot.respawn.mockImplementation(() => {
			throw new Error("respawn failed");
		});

		// death イベント発火時に例外がスローされず、ハンドラ全体がクラッシュしない
		expect(() => fakeBot.emit("death")).not.toThrow();

		// pushEvent は呼ばれている（イベント記録は正常に行われた）
		const deathEvents = ctx.events.filter((e) => e.kind === "death");
		expect(deathEvents).toHaveLength(1);
	});

	test("死亡ループ防止: クールダウン(1秒)経過後は再び respawn() が呼ばれる", async () => {
		setup();

		// 1回目の death → respawn() が呼ばれる
		fakeBot.emit("death");
		expect(fakeBot.respawn).toHaveBeenCalledTimes(1);

		// 直後（1秒未満）に2回目の death → respawn() はスキップされる
		fakeBot.emit("death");
		expect(fakeBot.respawn).toHaveBeenCalledTimes(1);

		// 1秒待ってクールダウンを超える
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 1100);
		});

		// 3回目の death → respawn() が再び呼ばれる
		fakeBot.emit("death");
		expect(fakeBot.respawn).toHaveBeenCalledTimes(2);

		// pushEvent("death", ...) は全3回とも呼ばれている
		const deathEvents = ctx.events.filter((e) => e.kind === "death");
		expect(deathEvents).toHaveLength(3);
	});
});
