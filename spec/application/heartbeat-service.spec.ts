import { describe, expect, mock, test } from "bun:test";

import {
	HeartbeatService,
	buildHeartbeatPrompt,
	groupByGuild,
} from "../../src/application/heartbeat-service.ts";
import type { AiAgent, DueReminder, Logger } from "../../src/core/types.ts";

function createMockLogger(): Logger {
	return {
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
	};
}

describe("buildHeartbeatPrompt", () => {
	test("due reminder を人間可読な prompt に変換する", () => {
		const prompt = buildHeartbeatPrompt([
			{
				reminder: {
					id: "r1",
					description: "水やり",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 10,
			},
		]);

		expect(prompt).toContain("水やり");
		expect(prompt).toContain("30分ごと");
	});
});

describe("groupByGuild", () => {
	test("guild ごとにまとめ、未指定は autonomous に送る", () => {
		const groups = groupByGuild([
			{
				reminder: {
					id: "g1",
					description: "guild",
					schedule: { type: "interval", minutes: 5 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "guild-1",
				},
				overdueMinutes: 0,
			},
			{
				reminder: {
					id: "global",
					description: "global",
					schedule: { type: "interval", minutes: 10 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 0,
			},
		]);

		expect(groups.get("guild-1")).toHaveLength(1);
		expect(groups.get("_autonomous")).toHaveLength(1);
	});
});

describe("HeartbeatService", () => {
	test("guild ごとに agent を呼び分け、成功した id を返す", async () => {
		const agent: AiAgent = {
			send: mock(() => Promise.resolve({ text: "", sessionId: "s1" })),
			stop: mock(() => {}),
		};
		const service = new HeartbeatService({ agent, logger: createMockLogger() });
		const dueReminders: DueReminder[] = [
			{
				reminder: {
					id: "r1",
					description: "a",
					schedule: { type: "interval", minutes: 15 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "guild-1",
				},
				overdueMinutes: 0,
			},
			{
				reminder: {
					id: "r2",
					description: "b",
					schedule: { type: "interval", minutes: 20 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 0,
			},
		];

		const result = await service.execute(dueReminders);

		expect(agent.send).toHaveBeenCalledTimes(2);
		expect(result.has("r1")).toBe(true);
		expect(result.has("r2")).toBe(true);
	});
});
