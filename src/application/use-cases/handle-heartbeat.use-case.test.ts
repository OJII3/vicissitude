import { describe, expect, it, mock } from "bun:test";

import type { DueReminder, HeartbeatConfig } from "../../domain/entities/heartbeat-config.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import { HandleHeartbeatUseCase } from "./handle-heartbeat.use-case.ts";
import {
	createMockAgent,
	createMockHeartbeatConfigRepository,
	createMockLogger,
} from "./test-helpers.ts";

const TEST_CONFIG: HeartbeatConfig = {
	baseIntervalMinutes: 1,
	reminders: [
		{
			id: "home-check",
			description: "ホームチャンネルの様子を見る",
			schedule: { type: "interval", minutes: 30 },
			lastExecutedAt: "2026-03-01T11:30:00Z",
			enabled: true,
		},
		{
			id: "memory-update",
			description: "メモリ確認",
			schedule: { type: "interval", minutes: 60 },
			lastExecutedAt: null,
			enabled: true,
		},
	],
};

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

	it("AI 成功時に config を load → 更新 → save する", async () => {
		const agent = createMockAgent({ text: "巡回完了", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository(TEST_CONFIG);
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		await useCase.execute(createDueReminders());

		expect(agent.send).toHaveBeenCalledTimes(1);
		expect(configRepo.load).toHaveBeenCalledTimes(1);
		expect(configRepo.save).toHaveBeenCalledTimes(1);

		const [savedConfig] = (configRepo.save as ReturnType<typeof mock>).mock.calls[0] as [
			HeartbeatConfig,
		];
		const updated = savedConfig.reminders.find((r) => r.id === "home-check");
		expect(updated?.lastExecutedAt).not.toBe("2026-03-01T11:30:00Z");
		expect(updated?.lastExecutedAt).toBeTruthy();

		const notUpdated = savedConfig.reminders.find((r) => r.id === "memory-update");
		expect(notUpdated?.lastExecutedAt).toBeNull();
	});

	it("AI 失敗時は config を更新しない", async () => {
		const agent: AiAgent = {
			send: mock(() => Promise.reject(new Error("AI down"))),
			stop: mock(() => {}),
		};
		const configRepo = createMockHeartbeatConfigRepository(TEST_CONFIG);
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		await useCase.execute(createDueReminders());

		expect(logger.error).toHaveBeenCalled();
		expect(configRepo.save).not.toHaveBeenCalled();
	});

	it("セッションキーが system:heartbeat:_autonomous である", async () => {
		const agent = createMockAgent({ text: "ok", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository(TEST_CONFIG);
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		await useCase.execute(createDueReminders());

		const [options] = (agent.send as ReturnType<typeof mock>).mock.calls[0] as [SendOptions];
		expect(options.sessionKey).toBe("system:heartbeat:_autonomous");
		expect(options.guildId).toBeUndefined();
	});
});

describe("HandleHeartbeatUseCase - 複数 Guild", () => {
	it("複数 Guild のリマインダーが Guild ごとに別セッションで実行される", async () => {
		const agent = createMockAgent({ text: "ok", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository(TEST_CONFIG);
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		const dueReminders: DueReminder[] = [
			{
				reminder: {
					id: "guild-a-check",
					description: "Guild A チェック",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "111",
				},
				overdueMinutes: 5,
			},
			{
				reminder: {
					id: "guild-b-check",
					description: "Guild B チェック",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "222",
				},
				overdueMinutes: 5,
			},
		];

		await useCase.execute(dueReminders);

		expect(agent.send).toHaveBeenCalledTimes(2);

		const calls = (agent.send as ReturnType<typeof mock>).mock.calls as [SendOptions][];
		const sessionKeys = calls.map(([opts]) => opts.sessionKey);
		const guildIds = calls.map(([opts]) => opts.guildId);

		expect(sessionKeys).toContain("system:heartbeat:111");
		expect(sessionKeys).toContain("system:heartbeat:222");
		expect(guildIds).toContain("111");
		expect(guildIds).toContain("222");
	});

	it("guildId ありとなしが混在する場合に正しくグルーピングされる", async () => {
		const agent = createMockAgent({ text: "ok", sessionId: "s1" });
		const configRepo = createMockHeartbeatConfigRepository(TEST_CONFIG);
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		const dueReminders: DueReminder[] = [
			{
				reminder: {
					id: "global-check",
					description: "グローバルチェック",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
				},
				overdueMinutes: 5,
			},
			{
				reminder: {
					id: "guild-check",
					description: "Guild チェック",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "111",
				},
				overdueMinutes: 5,
			},
		];

		await useCase.execute(dueReminders);

		expect(agent.send).toHaveBeenCalledTimes(2);

		const calls = (agent.send as ReturnType<typeof mock>).mock.calls as [SendOptions][];
		const sessionKeys = calls.map(([opts]) => opts.sessionKey);

		expect(sessionKeys).toContain("system:heartbeat:_autonomous");
		expect(sessionKeys).toContain("system:heartbeat:111");
	});

	it("一部 Guild の AI 失敗時は成功した Guild のみ lastExecutedAt を更新する", async () => {
		const agent: AiAgent = {
			send: mock((options: SendOptions) => {
				if (options.guildId === "222") {
					return Promise.reject(new Error("AI down for guild 222"));
				}
				return Promise.resolve({ text: "ok", sessionId: "s1" });
			}),
			stop: mock(() => {}),
		};

		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "guild-a-check",
					description: "Guild A チェック",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "111",
				},
				{
					id: "guild-b-check",
					description: "Guild B チェック",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
					guildId: "222",
				},
			],
		};
		const configRepo = createMockHeartbeatConfigRepository(config);
		const logger = createMockLogger();
		const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);

		const reminderA = config.reminders.find((r) => r.id === "guild-a-check");
		const reminderB = config.reminders.find((r) => r.id === "guild-b-check");
		if (!reminderA || !reminderB) throw new Error("Test setup error");

		const dueReminders: DueReminder[] = [
			{ reminder: reminderA, overdueMinutes: 5 },
			{ reminder: reminderB, overdueMinutes: 5 },
		];

		await useCase.execute(dueReminders);

		expect(agent.send).toHaveBeenCalledTimes(2);
		expect(logger.error).toHaveBeenCalled();
		expect(configRepo.save).toHaveBeenCalledTimes(1);

		const [savedConfig] = (configRepo.save as ReturnType<typeof mock>).mock.calls[0] as [
			HeartbeatConfig,
		];
		const guildA = savedConfig.reminders.find((r) => r.id === "guild-a-check");
		const guildB = savedConfig.reminders.find((r) => r.id === "guild-b-check");

		expect(guildA?.lastExecutedAt).toBeTruthy();
		expect(guildB?.lastExecutedAt).toBeNull();
	});
});
