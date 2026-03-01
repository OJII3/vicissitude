import { describe, expect, it, mock } from "bun:test";

import type { DueReminder } from "../../domain/entities/heartbeat-config.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import { HandleHeartbeatUseCase } from "./handle-heartbeat.use-case.ts";
import {
	createMockAgent,
	createMockHeartbeatConfigRepository,
	createMockLogger,
} from "./test-helpers.ts";

function createDueReminders(): DueReminder[] {
	return [
		{
			reminder: {
				id: "home-check",
				description: "ホームチャンネルの様子を見る",
				schedule: { type: "interval", minutes: 30 },
				lastExecutedAt: "2026-03-01T11:30:00Z",
				enabled: true,
			},
			overdueMinutes: 10,
		},
	];
}

describe("HandleHeartbeatUseCase", () => {
	it("プロンプトに日時とリマインダー情報が含まれる", () => {
		const agent = createMockAgent({ text: "ok", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository();
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		const prompt = useCase.buildPrompt(createDueReminders());

		expect(prompt).toContain("[heartbeat]");
		expect(prompt).toContain("ホームチャンネルの様子を見る");
		expect(prompt).toContain("30分ごと");
		expect(prompt).toContain("2026-03-01T11:30:00Z");
	});

	it("daily リマインダーのプロンプト表示", () => {
		const agent = createMockAgent({ text: "ok", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository();
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		const dueReminders: DueReminder[] = [
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

		const prompt = useCase.buildPrompt(dueReminders);

		expect(prompt).toContain("毎日 9:00");
		expect(prompt).toContain("朝の挨拶");
		expect(prompt).toContain("最後: なし");
	});

	it("AI 成功時に lastExecutedAt が更新される", async () => {
		const agent = createMockAgent({ text: "巡回完了", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository();
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		await useCase.execute(createDueReminders());

		expect(agent.send).toHaveBeenCalledTimes(1);
		expect(configRepo.updateLastExecuted).toHaveBeenCalledTimes(1);
		const [reminderId] = (configRepo.updateLastExecuted as ReturnType<typeof mock>).mock
			.calls[0] as [string, string];
		expect(reminderId).toBe("home-check");
	});

	it("AI 失敗時は lastExecutedAt を更新しない", async () => {
		const agent: AiAgent = {
			send: mock(() => Promise.reject(new Error("AI down"))),
			stop: mock(() => {}),
		};
		const configRepo = createMockHeartbeatConfigRepository();
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		await useCase.execute(createDueReminders());

		expect(configRepo.updateLastExecuted).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});

	it("セッションキーが system:heartbeat:_autonomous である", async () => {
		const agent = createMockAgent({ text: "ok", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository();
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		await useCase.execute(createDueReminders());

		const [sessionKey] = (agent.send as ReturnType<typeof mock>).mock.calls[0] as [string, string];
		expect(sessionKey).toBe("system:heartbeat:_autonomous");
	});
});
