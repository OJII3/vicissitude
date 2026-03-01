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

	it("daily: 時刻前なら not due", () => {
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
		const result = evaluateDueReminders(config, new Date("2026-03-01T08:30:00"));
		expect(result).toEqual([]);
	});

	it("daily: 時刻到達 + 未実行なら due", () => {
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
		const result = evaluateDueReminders(config, new Date("2026-03-01T09:15:00"));
		expect(result).toHaveLength(1);
		expect(result[0]?.overdueMinutes).toBe(15);
	});

	it("daily: 今日実行済みなら not due", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "morning",
					description: "朝の挨拶",
					schedule: { type: "daily", hour: 9, minute: 0 },
					lastExecutedAt: "2026-03-01T09:01:00",
					enabled: true,
				},
			],
		};
		const result = evaluateDueReminders(config, new Date("2026-03-01T10:00:00"));
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
					lastExecutedAt: "2026-03-01T11:40:00Z",
					enabled: true,
				},
				{
					id: "interval-not-due",
					description: "not due なインターバル",
					schedule: { type: "interval", minutes: 60 },
					lastExecutedAt: "2026-03-01T11:30:00Z",
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
		const result = evaluateDueReminders(config, new Date("2026-03-01T12:00:00"));
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.reminder.id)).toEqual(["interval-due", "daily-due"]);
	});
});
