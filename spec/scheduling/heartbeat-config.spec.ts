import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";
import type { HeartbeatConfig, HeartbeatReminder } from "@vicissitude/shared/types";

const EXECUTED_AT = "2026-05-16T01:23:45.000Z";

const addedReminder: HeartbeatReminder = {
	id: "guild-check",
	description: "ギルドの様子を見る",
	schedule: { type: "interval", minutes: 30 },
	lastExecutedAt: null,
	enabled: true,
	guildId: "123456789012345678",
};

function createTempConfigPath(): { dir: string; filePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "vicissitude-heartbeat-config-"));
	return { dir, filePath: join(dir, "heartbeat-config.json") };
}

function readConfig(filePath: string): HeartbeatConfig {
	return JSON.parse(readFileSync(filePath, "utf-8")) as HeartbeatConfig;
}

describe("JsonHeartbeatConfigRepository", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	test("stale な reminder 保存は並行した lastExecutedAt 更新を消さない", async () => {
		const temp = createTempConfigPath();
		tempDir = temp.dir;
		const repo = new JsonHeartbeatConfigRepository(temp.filePath);

		const schedulerConfig = await repo.load();
		const mcpConfig = await repo.load();

		const schedulerReminder = schedulerConfig.reminders.find((r) => r.id === "home-check");
		if (!schedulerReminder) {
			throw new Error("home-check reminder が見つかりません");
		}
		schedulerReminder.lastExecutedAt = EXECUTED_AT;
		await repo.save(schedulerConfig);

		mcpConfig.reminders.push(addedReminder);
		await repo.save(mcpConfig);

		const saved = readConfig(temp.filePath);
		expect(saved.reminders.some((r) => r.id === addedReminder.id)).toBe(true);
		expect(saved.reminders.find((r) => r.id === "home-check")?.lastExecutedAt).toBe(EXECUTED_AT);
	});

	test("markRemindersExecuted は現在の reminder 構成を保持して実行時刻だけ更新する", async () => {
		const temp = createTempConfigPath();
		tempDir = temp.dir;
		const repo = new JsonHeartbeatConfigRepository(temp.filePath);

		const config = await repo.load();
		config.reminders.push(addedReminder);
		await repo.save(config);

		await repo.markRemindersExecuted(["home-check"], EXECUTED_AT);

		const saved = readConfig(temp.filePath);
		expect(saved.reminders.some((r) => r.id === addedReminder.id)).toBe(true);
		expect(saved.reminders.find((r) => r.id === "home-check")?.lastExecutedAt).toBe(EXECUTED_AT);
	});
});
