import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { createMockLogger } from "@vicissitude/shared/test-helpers";

import { syncEmailCheckReminder } from "./migrations.ts";

describe("syncEmailCheckReminder 内部分岐", () => {
	const TEST_DIR = resolve(import.meta.dirname, "../.test-migrations-email-unit");
	const configPath = resolve(TEST_DIR, "heartbeat.json");

	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("reminders キー自体が無くても例外を投げずスキップする（optional chaining）", () => {
		writeFileSync(configPath, JSON.stringify({ baseIntervalMinutes: 30 }));
		const logger = createMockLogger();

		expect(() => syncEmailCheckReminder(configPath, true, logger)).not.toThrow();
		expect(logger.info).not.toHaveBeenCalled();
		// ファイルは書き換えられない
		expect(readFileSync(configPath, "utf-8")).toBe(JSON.stringify({ baseIntervalMinutes: 30 }));
	});

	it("一致時はファイルを書き換えない（writeFileSync を呼ばない）", () => {
		const original = JSON.stringify({ reminders: [{ id: "email-check", enabled: true }] });
		writeFileSync(configPath, original);
		const logger = createMockLogger();

		syncEmailCheckReminder(configPath, true, logger);

		// 整形（pretty-print）されていない = 書き換えが起きていない
		expect(readFileSync(configPath, "utf-8")).toBe(original);
	});

	it("差分がある時は 2 スペースインデントで整形して書き戻す", () => {
		writeFileSync(
			configPath,
			JSON.stringify({ reminders: [{ id: "email-check", enabled: false }] }),
		);
		const logger = createMockLogger();

		syncEmailCheckReminder(configPath, true, logger);

		const raw = readFileSync(configPath, "utf-8");
		expect(raw).toContain('  "reminders"');
		expect(JSON.parse(raw).reminders[0].enabled).toBe(true);
	});

	it("他の reminder の enabled には影響しない", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				reminders: [
					{ id: "mc-check", enabled: true },
					{ id: "email-check", enabled: false },
				],
			}),
		);
		const logger = createMockLogger();

		syncEmailCheckReminder(configPath, true, logger);

		const result = JSON.parse(readFileSync(configPath, "utf-8")) as {
			reminders: { id: string; enabled: boolean }[];
		};
		expect(result.reminders.find((r) => r.id === "mc-check")?.enabled).toBe(true);
		expect(result.reminders.find((r) => r.id === "email-check")?.enabled).toBe(true);
	});

	it("enabled にする時のログメッセージに enabled を含む", () => {
		writeFileSync(
			configPath,
			JSON.stringify({ reminders: [{ id: "email-check", enabled: false }] }),
		);
		const logger = createMockLogger();

		syncEmailCheckReminder(configPath, true, logger);

		const calls = logger.info.mock.calls as unknown as string[][];
		expect(calls[0]?.[0]).toContain("enabled");
	});

	it("disabled にする時のログメッセージに disabled を含む", () => {
		writeFileSync(
			configPath,
			JSON.stringify({ reminders: [{ id: "email-check", enabled: true }] }),
		);
		const logger = createMockLogger();

		syncEmailCheckReminder(configPath, false, logger);

		const calls = logger.info.mock.calls as unknown as string[][];
		expect(calls[0]?.[0]).toContain("disabled");
	});
});
