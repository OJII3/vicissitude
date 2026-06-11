import { describe, expect, mock, test } from "bun:test";

import {
	HeartbeatService,
	buildHeartbeatPrompt,
	groupByScope,
} from "@vicissitude/application/heartbeat-service";
import { discordScopeId } from "@vicissitude/shared/namespace";
import type { AiAgent, DueReminder } from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";

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
		expect(prompt).toContain("every 30min");
	});

	test("DueReminder.context を prompt に反映する", () => {
		const prompt = buildHeartbeatPrompt([
			{
				reminder: {
					id: "email-check",
					description: "メール確認",
					schedule: { type: "interval", minutes: 5 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 0,
				context: "<email_context>新着メール 1 件: 「件名」</email_context>",
			},
		]);

		expect(prompt).toContain("<email_context>新着メール 1 件: 「件名」</email_context>");
	});

	test("context が無い DueReminder は context を出力しない", () => {
		const prompt = buildHeartbeatPrompt([
			{
				reminder: {
					id: "home-check",
					description: "様子見",
					schedule: { type: "interval", minutes: 60 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 0,
			},
		]);

		expect(prompt).not.toContain("<email_context>");
	});
});

describe("groupByScope", () => {
	test("scope ごとにまとめ、未指定は autonomous に送る", () => {
		const groups = groupByScope([
			{
				reminder: {
					id: "g1",
					description: "scope",
					schedule: { type: "interval", minutes: 5 },
					lastExecutedAt: null,
					enabled: true,
					scopeId: discordScopeId("111111111111111111"),
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

		expect(groups.get(discordScopeId("111111111111111111"))).toHaveLength(1);
		expect(groups.get("_autonomous")).toHaveLength(1);
	});
});

describe("HeartbeatService", () => {
	test("scope ごとに agent を呼び分け、成功した id を返す", async () => {
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
					scopeId: discordScopeId("111111111111111111"),
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
