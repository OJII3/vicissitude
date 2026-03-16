import { describe, expect, test } from "bun:test";

import { createBotContext } from "@vicissitude/minecraft/bot-context";

describe("createBotContext", () => {
	test("初期状態: getBot() は null", () => {
		const ctx = createBotContext();
		expect(ctx.getBot()).toBeNull();
	});

	test("初期状態: getEvents() は空配列", () => {
		const ctx = createBotContext();
		expect(ctx.getEvents()).toEqual([]);
	});

	test("初期状態: getActionState().type は idle", () => {
		const ctx = createBotContext();
		expect(ctx.getActionState().type).toBe("idle");
	});
});

describe("setBot / getBot", () => {
	test("null を設定・取得できる", () => {
		const ctx = createBotContext();
		ctx.setBot(null);
		expect(ctx.getBot()).toBeNull();
	});
});

describe("pushEvent", () => {
	test("イベントが追加される", () => {
		const ctx = createBotContext();
		ctx.pushEvent("chat", "hello", "low");
		const events = ctx.getEvents();
		expect(events).toHaveLength(1);
		expect(events.at(0)?.kind).toBe("chat");
		expect(events.at(0)?.description).toBe("hello");
		expect(events.at(0)?.importance).toBe("low");
		expect(events.at(0)?.timestamp).toBeTruthy();
	});

	test("MAX_EVENTS (100) を超えると先頭が削除される", () => {
		const ctx = createBotContext();
		for (let i = 0; i < 101; i++) {
			ctx.pushEvent("tick", `event-${String(i)}`, "low");
		}
		const events = ctx.getEvents();
		expect(events).toHaveLength(100);
		expect(events.at(0)?.description).toBe("event-1");
		expect(events.at(99)?.description).toBe("event-100");
	});

	test("urgentEventNotifier がイベントを受け取る", () => {
		const received: { kind: string; description: string; importance: string }[] = [];
		const ctx = createBotContext({
			urgentEventNotifier: (kind, description, importance) => {
				received.push({ kind, description, importance });
			},
		});
		ctx.pushEvent("damage", "Bot took damage", "medium");
		expect(received).toEqual([
			{ kind: "damage", description: "Bot took damage", importance: "medium" },
		]);
	});
});

describe("setActionState", () => {
	test("全フィールドが正しく上書きされる", () => {
		const ctx = createBotContext();
		ctx.setActionState({
			type: "collecting",
			target: "oak_log",
			jobId: "job-1",
			progress: "3/10",
		});
		const state = ctx.getActionState();
		expect(state.type).toBe("collecting");
		expect(state.target).toBe("oak_log");
		expect(state.jobId).toBe("job-1");
		expect(state.progress).toBe("3/10");
	});

	test("idle に遷移すると target/jobId/progress が undefined になる", () => {
		const ctx = createBotContext();
		ctx.setActionState({
			type: "collecting",
			target: "oak_log",
			jobId: "job-1",
			progress: "3/10",
		});
		ctx.setActionState({ type: "idle" });
		const state = ctx.getActionState();
		expect(state.type).toBe("idle");
		expect(state.target).toBeUndefined();
		expect(state.jobId).toBeUndefined();
		expect(state.progress).toBeUndefined();
	});
});

describe("getEvents 参照", () => {
	test("getEvents() は内部配列への参照を返す", () => {
		const ctx = createBotContext();
		const before = ctx.getEvents();
		ctx.pushEvent("chat", "test", "medium");
		const after = ctx.getEvents();
		expect(before).toBe(after);
		expect(before).toHaveLength(1);
	});
});
