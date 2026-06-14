import { describe, expect, it, test } from "bun:test";

import { splitMessage } from "@vicissitude/application/split-message";
import { evaluateDueReminders } from "@vicissitude/scheduling/heartbeat-helpers";
import {
	abortReasonToError,
	formatTime,
	formatTimestamp,
	isRecord,
	raceAbort,
	sleep,
	withTimeout,
} from "@vicissitude/shared/functions";
import type { HeartbeatConfig } from "@vicissitude/shared/types";

// ─── splitMessage ────────────────────────────────────────────────

describe("splitMessage", () => {
	it("短いメッセージはそのまま返る", () => {
		const result = splitMessage("hello");
		expect(result).toEqual(["hello"]);
	});

	it("maxLength 以下のメッセージは分割されない", () => {
		const text = "a".repeat(2000);
		const result = splitMessage(text);
		expect(result).toEqual([text]);
	});

	it("maxLength 超のメッセージが分割される", () => {
		const text = "a".repeat(3000);
		const result = splitMessage(text, 2000);
		expect(result.length).toBe(2);
		expect(result[0]).toBe("a".repeat(2000));
		expect(result[1]).toBe("a".repeat(1000));
	});

	it("改行位置で分割される", () => {
		const line = "a".repeat(50);
		const text = `${line}\n${line}\n${line}`;
		const result = splitMessage(text, 55);
		expect(result).toEqual([line, line, line]);
	});

	it("改行文字が次チャンクの先頭に残らない", () => {
		const text = "aaa\nbbb";
		const result = splitMessage(text, 5);
		expect(result[0]).toBe("aaa");
		expect(result[1]).toBe("bbb");
	});

	it("カスタム maxLength を指定できる", () => {
		const text = "a".repeat(20);
		const result = splitMessage(text, 10);
		expect(result).toEqual(["a".repeat(10), "a".repeat(10)]);
	});
});

// ─── evaluateDueReminders ────────────────────────────────────────

describe("evaluateDueReminders", () => {
	it("リマインダーが空の場合は空配列を返す", () => {
		const config: HeartbeatConfig = { baseIntervalMinutes: 1, reminders: [] };
		const result = evaluateDueReminders(config, new Date("2026-03-01T12:00:00Z"));
		expect(result).toEqual([]);
	});

	it("disabled なリマインダーはスキップする", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "test",
					description: "テスト",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: false,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T12:00:00Z"));
		expect(result).toEqual([]);
	});

	it("interval: lastExecutedAt が null なら due", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "test",
					description: "テスト",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T12:00:00Z"));
		expect(result).toHaveLength(1);
		expect(result[0]?.reminder.id).toBe("test");
		expect(result[0]?.overdueMinutes).toBe(30);
	});

	it("interval: 経過時間が足りなければ not due", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "test",
					description: "テスト",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: "2026-03-01T11:40:00Z",
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T12:00:00Z"));
		expect(result).toEqual([]);
	});

	it("interval: 経過時間が足りていれば due", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "test",
					description: "テスト",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: "2026-03-01T11:20:00Z",
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T12:00:00Z"));
		expect(result).toHaveLength(1);
		expect(result[0]?.overdueMinutes).toBe(10);
	});

	it("daily: 時刻前なら not due（JST 8:30 = UTC 23:30 前日）", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "morning",
					description: "朝の挨拶",
					schedule: { type: "daily", hour: 9, minute: 0 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-02-28T23:30:00Z"));
		expect(result).toEqual([]);
	});

	it("daily: 時刻到達 + 未実行なら due（JST 9:15 = UTC 0:15）", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "morning",
					description: "朝の挨拶",
					schedule: { type: "daily", hour: 9, minute: 0 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T00:15:00Z"));
		expect(result).toHaveLength(1);
		expect(result[0]?.overdueMinutes).toBe(15);
	});

	it("daily: 今日実行済みなら not due（JST 10:00 = UTC 1:00）", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "morning",
					description: "朝の挨拶",
					schedule: { type: "daily", hour: 9, minute: 0 },
					lastExecutedAt: "2026-03-01T00:01:00Z",
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T01:00:00Z"));
		expect(result).toEqual([]);
	});

	it("複数リマインダーの混在", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "interval-due",
					description: "due なインターバル",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: "2026-03-01T02:40:00Z",
					enabled: true,
				},
				{
					id: "interval-not-due",
					description: "not due なインターバル",
					schedule: { type: "interval", minutes: 60 },
					lastExecutedAt: "2026-03-01T02:30:00Z",
					enabled: true,
				},
				{
					id: "disabled",
					description: "無効",
					schedule: { type: "interval", minutes: 5 },
					lastExecutedAt: null,
					enabled: false,
				},
				{
					id: "daily-due",
					description: "due な日次",
					schedule: { type: "daily", hour: 9, minute: 0 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T03:00:00Z"));
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.reminder.id)).toEqual(["interval-due", "daily-due"]);
	});
});

// ─── formatTimestamp / formatTime ────────────────────────────────

describe("formatTimestamp", () => {
	it("UTC を JST (UTC+9) に変換して YYYY-MM-DD HH:mm 形式で返す", () => {
		const date = new Date("2026-03-01T06:30:00Z");
		expect(formatTimestamp(date)).toBe("2026-03-01 15:30");
	});

	it("日付またぎ: UTC 15:00 → JST 翌日 00:00", () => {
		const date = new Date("2026-03-01T15:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-03-02 00:00");
	});

	it("月またぎ: UTC 1月31日 23:00 → JST 2月1日 08:00", () => {
		const date = new Date("2026-01-31T23:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-02-01 08:00");
	});

	it("年またぎ: UTC 12月31日 15:00 → JST 1月1日 00:00", () => {
		const date = new Date("2025-12-31T15:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-01-01 00:00");
	});

	it("1桁の月・日・時・分はゼロ埋めされる", () => {
		const date = new Date("2026-01-02T00:05:00Z");
		expect(formatTimestamp(date)).toBe("2026-01-02 09:05");
	});

	it("UTC 0時ちょうど → JST 09:00", () => {
		const date = new Date("2026-06-15T00:00:00Z");
		expect(formatTimestamp(date)).toBe("2026-06-15 09:00");
	});
});

describe("formatTime", () => {
	it("HH:mm 形式で JST 時刻を返す", () => {
		const date = new Date("2026-03-01T06:30:00Z");
		expect(formatTime(date)).toBe("15:30");
	});

	it("日付またぎでも時刻部分のみ返す", () => {
		const date = new Date("2026-03-01T15:00:00Z");
		expect(formatTime(date)).toBe("00:00");
	});

	it("1桁の時・分はゼロ埋めされる", () => {
		const date = new Date("2026-01-01T00:05:00Z");
		expect(formatTime(date)).toBe("09:05");
	});
});

// ─── withTimeout ─────────────────────────────────────────────────

describe("withTimeout", () => {
	test("resolves when promise completes before timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 1000, "timed out");
		expect(result).toBe("ok");
	});

	test("rejects with timeout error when promise takes too long", () => {
		const slow = new Promise<string>((resolve) => {
			setTimeout(() => resolve("late"), 500);
		});
		expect(withTimeout(slow, 10, "timed out")).rejects.toThrow("timed out");
	});

	test("propagates original error when promise rejects before timeout", () => {
		const failing = Promise.reject(new Error("original"));
		expect(withTimeout(failing, 1000, "timed out")).rejects.toThrow("original");
	});
});

// ─── sleep ───────────────────────────────────────────────────────

describe("sleep", () => {
	test("指定ミリ秒後に resolve する", async () => {
		const start = Date.now();
		await sleep(20);
		expect(Date.now() - start).toBeGreaterThanOrEqual(15);
	});

	test("void に解決する（値を返さない）", async () => {
		const result = await sleep(1);
		expect(result).toBeUndefined();
	});

	test("signal 省略時は時間どおり待機して resolve する", async () => {
		expect(await sleep(1)).toBeUndefined();
	});

	test("待機中に abort されたら setTimeout を待たず即座に resolve する（reject しない）", async () => {
		const controller = new AbortController();
		const start = Date.now();
		const promise = sleep(10_000, controller.signal);
		controller.abort();
		expect(await promise).toBeUndefined();
		expect(Date.now() - start).toBeLessThan(1000);
	});

	test("すでに abort 済みの signal を渡すと即座に resolve する", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await sleep(10_000, controller.signal)).toBeUndefined();
	});

	test("abort されなければ通常どおり時間待機して resolve する", async () => {
		const controller = new AbortController();
		expect(await sleep(5, controller.signal)).toBeUndefined();
	});
});

// ─── isRecord ────────────────────────────────────────────────────

describe("isRecord", () => {
	test("プレーンオブジェクトは true", () => {
		expect(isRecord({ a: 1 })).toBe(true);
	});

	test("空オブジェクトは true", () => {
		expect(isRecord({})).toBe(true);
	});

	test("配列は false（レコードとして扱わない）", () => {
		expect(isRecord([1, 2, 3])).toBe(false);
	});

	test("空配列も false", () => {
		expect(isRecord([])).toBe(false);
	});

	test("null は false", () => {
		expect(isRecord(null)).toBe(false);
	});

	test("undefined は false", () => {
		const value: unknown = undefined;
		expect(isRecord(value)).toBe(false);
	});

	test("文字列は false", () => {
		expect(isRecord("str")).toBe(false);
	});

	test("数値は false", () => {
		expect(isRecord(42)).toBe(false);
	});

	test("型ガードとして value.key へ安全にアクセスできる", () => {
		const value: unknown = { message: "hello" };
		if (isRecord(value)) {
			expect(value.message).toBe("hello");
		} else {
			throw new Error("expected isRecord to narrow");
		}
	});
});

// ─── abortReasonToError ──────────────────────────────────────────

describe("abortReasonToError", () => {
	test("reason が Error ならそのまま返す", () => {
		const controller = new AbortController();
		const original = new Error("custom abort");
		controller.abort(original);
		expect(abortReasonToError(controller.signal)).toBe(original);
	});

	test("reason が非 Error なら AbortError(DOMException) に正規化する", () => {
		const controller = new AbortController();
		controller.abort("string reason");
		const error = abortReasonToError(controller.signal);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("AbortError");
	});

	test("reason 未指定（abort()）でも AbortError に正規化する", () => {
		const controller = new AbortController();
		controller.abort();
		const error = abortReasonToError(controller.signal);
		expect(error.name).toBe("AbortError");
	});

	test("AbortSignal.timeout 由来の TimeoutError をそのまま返す", async () => {
		const signal = AbortSignal.timeout(1);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 10);
		});
		const error = abortReasonToError(signal);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("TimeoutError");
	});
});

// ─── raceAbort ───────────────────────────────────────────────────

describe("raceAbort", () => {
	test("promise が先に解決したらその値を返す", async () => {
		const controller = new AbortController();
		const result = await raceAbort(Promise.resolve("ok"), controller.signal);
		expect(result).toBe("ok");
	});

	test("promise が先に reject したらその error を伝播する", () => {
		const controller = new AbortController();
		const failing = Promise.reject(new Error("inner failure"));
		expect(raceAbort(failing, controller.signal)).rejects.toThrow("inner failure");
	});

	test("signal が先に abort したら abortReasonToError 正規化済み Error で reject する", () => {
		const controller = new AbortController();
		const reason = new Error("aborted by signal");
		// 永久 pending
		const pending = new Promise<string>(() => {});
		const promise = raceAbort(pending, controller.signal);
		controller.abort(reason);
		expect(promise).rejects.toBe(reason);
	});

	test("すでに abort 済みの signal なら即座に reject する", () => {
		const controller = new AbortController();
		controller.abort();
		const pending = new Promise<string>(() => {});
		const promise = raceAbort(pending, controller.signal);
		expect(promise).rejects.toThrow();
	});

	test("非 Error reason での abort は AbortError に正規化して reject する", () => {
		const controller = new AbortController();
		const pending = new Promise<string>(() => {});
		const promise = raceAbort(pending, controller.signal);
		controller.abort("nope");
		expect(promise).rejects.toMatchObject({ name: "AbortError" });
	});
});
