import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import type { Logger } from "@vicissitude/shared/types";

import {
	migrateMemoryDir,
	removeLegacyConsolidateReminder,
	syncMcCheckReminder,
} from "../../apps/discord/src/migrations.ts";

function makeLogger(): Logger {
	const logger: Logger = {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
		child: mock(() => logger),
	};
	return logger;
}

describe("syncMcCheckReminder", () => {
	const TEST_DIR = resolve(import.meta.dirname, "../../.test-migrations-sync");
	const configPath = resolve(TEST_DIR, "heartbeat.json");

	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("ファイルが存在しない場合は何もしない", () => {
		const logger = makeLogger();
		syncMcCheckReminder(resolve(TEST_DIR, "nonexistent.json"), true, logger);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("mc-check リマインダーが存在しない場合は何もしない", () => {
		writeFileSync(configPath, JSON.stringify({ reminders: [] }));
		const logger = makeLogger();
		syncMcCheckReminder(configPath, true, logger);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("mc-check の enabled が既に一致している場合は何もしない", () => {
		writeFileSync(configPath, JSON.stringify({ reminders: [{ id: "mc-check", enabled: true }] }));
		const logger = makeLogger();
		syncMcCheckReminder(configPath, true, logger);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("minecraftEnabled=true のとき mc-check を enabled にする", () => {
		writeFileSync(configPath, JSON.stringify({ reminders: [{ id: "mc-check", enabled: false }] }));
		const logger = makeLogger();
		syncMcCheckReminder(configPath, true, logger);

		const result = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(result.reminders[0].enabled).toBe(true);
		expect(logger.info).toHaveBeenCalled();
	});

	it("minecraftEnabled=false のとき mc-check を disabled にする", () => {
		writeFileSync(configPath, JSON.stringify({ reminders: [{ id: "mc-check", enabled: true }] }));
		const logger = makeLogger();
		syncMcCheckReminder(configPath, false, logger);

		const result = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(result.reminders[0].enabled).toBe(false);
	});

	it("不正な JSON の場合は例外をスローせずスキップする", () => {
		writeFileSync(configPath, "not json");
		const logger = makeLogger();
		expect(() => syncMcCheckReminder(configPath, true, logger)).not.toThrow();
	});
});

describe("removeLegacyConsolidateReminder", () => {
	const TEST_DIR = resolve(import.meta.dirname, "../../.test-migrations-remove");
	const configPath = resolve(TEST_DIR, "heartbeat.json");

	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("ファイルが存在しない場合は何もしない", () => {
		const logger = makeLogger();
		removeLegacyConsolidateReminder(resolve(TEST_DIR, "nonexistent.json"), logger);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("reminders が存在しない場合は何もしない", () => {
		writeFileSync(configPath, JSON.stringify({}));
		const logger = makeLogger();
		removeLegacyConsolidateReminder(configPath, logger);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("ltm-consolidate が存在しない場合は何もしない", () => {
		writeFileSync(configPath, JSON.stringify({ reminders: [{ id: "mc-check" }] }));
		const logger = makeLogger();
		removeLegacyConsolidateReminder(configPath, logger);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("ltm-consolidate リマインダーを削除する", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				reminders: [{ id: "mc-check", enabled: true }, { id: "ltm-consolidate" }],
			}),
		);
		const logger = makeLogger();
		removeLegacyConsolidateReminder(configPath, logger);

		const result = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(result.reminders).toHaveLength(1);
		expect(result.reminders[0].id).toBe("mc-check");
		expect(logger.info).toHaveBeenCalled();
	});

	it("不正な JSON の場合は例外をスローせずスキップする", () => {
		writeFileSync(configPath, "not json");
		const logger = makeLogger();
		expect(() => removeLegacyConsolidateReminder(configPath, logger)).not.toThrow();
	});
});

describe("migrateMemoryDir", () => {
	const TEST_DIR = resolve(import.meta.dirname, "../../.test-migrations-migrate");

	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("ltm ディレクトリが存在しない場合は何もしない", () => {
		const logger = makeLogger();
		migrateMemoryDir(TEST_DIR, logger);
		expect(logger.info).not.toHaveBeenCalled();
		expect(existsSync(resolve(TEST_DIR, "memory"))).toBe(false);
	});

	it("ltm を memory にリネームする", () => {
		mkdirSync(resolve(TEST_DIR, "ltm"));
		writeFileSync(resolve(TEST_DIR, "ltm/test.txt"), "data");
		const logger = makeLogger();

		migrateMemoryDir(TEST_DIR, logger);

		expect(existsSync(resolve(TEST_DIR, "ltm"))).toBe(false);
		expect(existsSync(resolve(TEST_DIR, "memory"))).toBe(true);
		expect(readFileSync(resolve(TEST_DIR, "memory/test.txt"), "utf-8")).toBe("data");
		expect(logger.info).toHaveBeenCalled();
	});

	it("memory が既に存在する場合はリネームしない", () => {
		mkdirSync(resolve(TEST_DIR, "ltm"));
		mkdirSync(resolve(TEST_DIR, "memory"));
		const logger = makeLogger();

		migrateMemoryDir(TEST_DIR, logger);

		expect(existsSync(resolve(TEST_DIR, "ltm"))).toBe(true);
		expect(logger.info).not.toHaveBeenCalled();
	});
});
