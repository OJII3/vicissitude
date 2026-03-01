import { describe, expect, it } from "bun:test";

import type { HeartbeatConfig } from "../entities/heartbeat-config.ts";
import { evaluateDueReminders } from "./heartbeat-evaluator.ts";

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
		// JST 8:30 = UTC 23:30 前日
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
		// JST 9:15 = UTC 0:15
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
					// JST 9:01 = UTC 0:01
					lastExecutedAt: "2026-03-01T00:01:00Z",
					enabled: true,
				},
			],
		};
		// JST 10:00 = UTC 1:00
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
		// JST 12:00 = UTC 3:00。interval-due は 20分超過で due、daily-due は JST 9:00 超過で due
		const result = evaluateDueReminders(config, new Date("2026-03-01T03:00:00Z"));
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.reminder.id)).toEqual(["interval-due", "daily-due"]);
	});
});
