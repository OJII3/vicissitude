import { describe, expect, it } from "bun:test";

import type { DueReminder } from "../core/types.ts";
import { buildHeartbeatPrompt, groupByGuild } from "./scheduler.ts";

// ─── buildHeartbeatPrompt ────────────────────────────────────────

describe("buildHeartbeatPrompt", () => {
	it("interval リマインダーのプロンプトを生成する", () => {
		const reminders: DueReminder[] = [
			{
				reminder: {
					id: "check",
					description: "ホームチャンネルの様子を見る",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: "2026-03-01T00:00:00Z",
					enabled: true,
				},
				overdueMinutes: 5,
			},
		];
		const result = buildHeartbeatPrompt(reminders);
		expect(result).toContain("[heartbeat]");
		expect(result).toContain("30分ごと");
		expect(result).toContain("ホームチャンネルの様子を見る");
		expect(result).toContain("2026-03-01T00:00:00Z");
	});

	it("daily リマインダーのスケジュール表記が正しい", () => {
		const reminders: DueReminder[] = [
			{
				reminder: {
					id: "morning",
					description: "朝の挨拶",
					schedule: { type: "daily", hour: 9, minute: 0 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 15,
			},
		];
		const result = buildHeartbeatPrompt(reminders);
		expect(result).toContain("毎日 9:00");
		expect(result).toContain("朝の挨拶");
		expect(result).toContain("なし");
	});

	it("複数のリマインダーがすべてプロンプトに含まれる", () => {
		const reminders: DueReminder[] = [
			{
				reminder: {
					id: "r1",
					description: "タスクA",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 10,
			},
			{
				reminder: {
					id: "r2",
					description: "タスクB",
					schedule: { type: "daily", hour: 21, minute: 30 },
					lastExecutedAt: "2026-03-01T12:00:00Z",
					enabled: true,
				},
				overdueMinutes: 5,
			},
		];
		const result = buildHeartbeatPrompt(reminders);
		expect(result).toContain("タスクA");
		expect(result).toContain("タスクB");
		expect(result).toContain("10分ごと");
		expect(result).toContain("毎日 21:30");
	});
});

// ─── groupByGuild ────────────────────────────────────────────────

describe("groupByGuild", () => {
	it("guildId ごとにグルーピングされる", () => {
		const reminders: DueReminder[] = [
			{
				reminder: {
					id: "r1",
					description: "A",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "guild-1",
				},
				overdueMinutes: 5,
			},
			{
				reminder: {
					id: "r2",
					description: "B",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "guild-2",
				},
				overdueMinutes: 5,
			},
			{
				reminder: {
					id: "r3",
					description: "C",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "guild-1",
				},
				overdueMinutes: 5,
			},
		];

		const groups = groupByGuild(reminders);
		expect(groups.size).toBe(2);
		expect(groups.get("guild-1")).toHaveLength(2);
		expect(groups.get("guild-2")).toHaveLength(1);
	});

	it("guildId が未定義なら _autonomous にグルーピングされる", () => {
		const reminders: DueReminder[] = [
			{
				reminder: {
					id: "r1",
					description: "A",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 5,
			},
		];

		const groups = groupByGuild(reminders);
		expect(groups.size).toBe(1);
		expect(groups.has("_autonomous")).toBe(true);
		expect(groups.get("_autonomous")).toHaveLength(1);
	});

	it("空配列なら空の Map を返す", () => {
		const groups = groupByGuild([]);
		expect(groups.size).toBe(0);
	});

	it("guildId ありと未定義が混在する", () => {
		const reminders: DueReminder[] = [
			{
				reminder: {
					id: "r1",
					description: "A",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "guild-1",
				},
				overdueMinutes: 5,
			},
			{
				reminder: {
					id: "r2",
					description: "B",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 5,
			},
		];

		const groups = groupByGuild(reminders);
		expect(groups.size).toBe(2);
		expect(groups.has("guild-1")).toBe(true);
		expect(groups.has("_autonomous")).toBe(true);
	});
});
