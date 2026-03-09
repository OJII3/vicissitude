import { describe, expect, it, test } from "bun:test";

import {
	evaluateDueReminders,
	formatTime,
	formatTimestamp,
	splitMessage,
	withTimeout,
} from "./functions.ts";
import type { HeartbeatConfig } from "./types.ts";

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

	test("rejects with timeout error when promise takes too long", async () => {
		const slow = new Promise<string>((resolve) => {
			setTimeout(() => resolve("late"), 500);
		});
		await expect(withTimeout(slow, 10, "timed out")).rejects.toThrow("timed out");
	});

	test("propagates original error when promise rejects before timeout", async () => {
		const failing = Promise.reject(new Error("original"));
		await expect(withTimeout(failing, 1000, "timed out")).rejects.toThrow("original");
	});
});
