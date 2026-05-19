import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { JsonHeartbeatConfigRepository } from "@vicissitude/scheduling/heartbeat-config";
import { createDefaultHeartbeatConfig } from "@vicissitude/scheduling/heartbeat-helpers";
import { discordScopeId } from "@vicissitude/shared/namespace";
import type { HeartbeatConfig, HeartbeatReminder } from "@vicissitude/shared/types";

const EXECUTED_AT = "2026-05-16T01:23:45.000Z";

const addedReminder: HeartbeatReminder = {
	id: "scope-check",
	description: "scope の様子を見る",
	schedule: { type: "interval", minutes: 30 },
	lastExecutedAt: null,
	enabled: true,
	scopeId: discordScopeId("123456789012345678"),
};

function createTempConfigPath(): { dir: string; filePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "vicissitude-heartbeat-config-"));
	return { dir, filePath: join(dir, "heartbeat-config.json") };
}

function readConfig(filePath: string): HeartbeatConfig {
	return JSON.parse(readFileSync(filePath, "utf-8")) as HeartbeatConfig;
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
	await promise.then(
		() => {
			throw new Error(`Expected promise to reject with: ${message}`);
		},
		(error) => {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(message);
		},
	);
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

	test("legacy guildId reminder は scopeId に migration され、ファイルも更新される", async () => {
		const temp = createTempConfigPath();
		tempDir = temp.dir;
		const repo = new JsonHeartbeatConfigRepository(temp.filePath);
		writeFileSync(
			temp.filePath,
			JSON.stringify({
				baseIntervalMinutes: 1,
				reminders: [
					{
						id: "legacy",
						description: "legacy reminder",
						schedule: { type: "interval", minutes: 30 },
						lastExecutedAt: null,
						enabled: true,
						guildId: "123456789012345678",
					},
				],
			}),
		);

		const loaded = await repo.load();
		const saved = readConfig(temp.filePath);

		expect(loaded.reminders[0]?.scopeId).toBe(discordScopeId("123456789012345678"));
		expect(saved.reminders[0]?.scopeId).toBe(discordScopeId("123456789012345678"));
		expect("guildId" in (saved.reminders[0] ?? {})).toBe(false);
	});

	test("設定ファイルがない場合は default config を返し、load だけではファイルを作らない", async () => {
		const temp = createTempConfigPath();
		tempDir = temp.dir;
		const repo = new JsonHeartbeatConfigRepository(temp.filePath);

		const config = await repo.load();

		expect(config).toEqual(createDefaultHeartbeatConfig());
		expect(existsSync(temp.filePath)).toBe(false);
	});

	test("JSON が壊れた設定は default 扱いせず、save で上書きしない", async () => {
		const temp = createTempConfigPath();
		tempDir = temp.dir;
		const repo = new JsonHeartbeatConfigRepository(temp.filePath);
		const brokenJson = "{ broken";
		writeFileSync(temp.filePath, brokenJson);

		await expectRejectsWithMessage(repo.load(), "Invalid heartbeat config JSON");
		await expectRejectsWithMessage(
			repo.save(createDefaultHeartbeatConfig()),
			"Invalid heartbeat config JSON",
		);

		expect(readFileSync(temp.filePath, "utf-8")).toBe(brokenJson);
	});

	test("schema に合わない設定は default 扱いせず、save で上書きしない", async () => {
		const temp = createTempConfigPath();
		tempDir = temp.dir;
		const repo = new JsonHeartbeatConfigRepository(temp.filePath);
		const invalidConfig = JSON.stringify({ baseIntervalMinutes: "1", reminders: [] });
		writeFileSync(temp.filePath, invalidConfig);

		await expectRejectsWithMessage(repo.load(), "Invalid heartbeat config schema");
		await expectRejectsWithMessage(
			repo.save(createDefaultHeartbeatConfig()),
			"Invalid heartbeat config schema",
		);

		expect(readFileSync(temp.filePath, "utf-8")).toBe(invalidConfig);
	});
});
