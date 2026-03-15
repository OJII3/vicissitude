import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import {
	OVERLAY_CONTEXT_DIR,
	guildIdSchema,
	isDateWithinRange,
	readWithFallbackFrom,
	resolveContextPaths,
	todayDateString,
} from "../../src/mcp/memory-helpers.ts";

describe("resolveContextPaths", () => {
	it("guildId 未指定時はオーバーレイベースのグローバルパスを返す", () => {
		const paths = resolveContextPaths();

		expect(paths.memoryPath).toContain("data/context/MEMORY.md");
		expect(paths.lessonsPath).toContain("data/context/LESSONS.md");
		expect(paths.memoryDir).toContain("data/context/memory");
		expect(paths.memoryPath).not.toContain("guilds");
	});

	it("guildId 指定時は Guild 固有パスを返す", () => {
		const paths = resolveContextPaths("123456789");

		expect(paths.memoryPath).toContain("data/context/guilds/123456789/MEMORY.md");
		expect(paths.lessonsPath).toContain("data/context/guilds/123456789/LESSONS.md");
		expect(paths.memoryDir).toContain("data/context/guilds/123456789/memory");
	});

	it("OVERLAY_CONTEXT_DIR をベースにしたパスを返す", () => {
		const paths = resolveContextPaths();

		expect(paths.memoryPath).toStartWith(OVERLAY_CONTEXT_DIR);
	});
});

describe("readWithFallbackFrom", () => {
	const TEST_ROOT = resolve(import.meta.dirname, "../../.test-fallback");
	const TEST_OVERLAY = resolve(TEST_ROOT, "overlay");
	const TEST_BASE = resolve(TEST_ROOT, "base");

	beforeEach(() => {
		mkdirSync(TEST_OVERLAY, { recursive: true });
		mkdirSync(TEST_BASE, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	});

	it("overlay にファイルがあれば overlay を返す", () => {
		writeFileSync(resolve(TEST_OVERLAY, "FILE.md"), "overlay content", "utf-8");
		writeFileSync(resolve(TEST_BASE, "FILE.md"), "base content", "utf-8");

		const content = readWithFallbackFrom(resolve(TEST_OVERLAY, "FILE.md"), TEST_OVERLAY, TEST_BASE);
		expect(content).toBe("overlay content");
	});

	it("overlay にない場合は base にフォールバックする", () => {
		writeFileSync(resolve(TEST_BASE, "FILE.md"), "base content", "utf-8");

		const content = readWithFallbackFrom(resolve(TEST_OVERLAY, "FILE.md"), TEST_OVERLAY, TEST_BASE);
		expect(content).toBe("base content");
	});

	it("どちらにもない場合は空文字を返す", () => {
		const content = readWithFallbackFrom(
			resolve(TEST_OVERLAY, "NONEXISTENT.md"),
			TEST_OVERLAY,
			TEST_BASE,
		);
		expect(content).toBe("");
	});

	it("overlay に空ファイルがある場合はフォールバックせず空文字を返す", () => {
		writeFileSync(resolve(TEST_OVERLAY, "EMPTY.md"), "", "utf-8");
		writeFileSync(resolve(TEST_BASE, "EMPTY.md"), "base content", "utf-8");

		const content = readWithFallbackFrom(
			resolve(TEST_OVERLAY, "EMPTY.md"),
			TEST_OVERLAY,
			TEST_BASE,
		);
		expect(content).toBe("");
	});

	it("overlay に空白のみのファイルがある場合はフォールバックせず空白を返す", () => {
		writeFileSync(resolve(TEST_OVERLAY, "WHITESPACE.md"), "  \n", "utf-8");
		writeFileSync(resolve(TEST_BASE, "WHITESPACE.md"), "base content", "utf-8");

		const content = readWithFallbackFrom(
			resolve(TEST_OVERLAY, "WHITESPACE.md"),
			TEST_OVERLAY,
			TEST_BASE,
		);
		expect(content).toBe("  \n");
	});
});

describe("isDateWithinRange", () => {
	it("今日の日付は範囲内", () => {
		expect(isDateWithinRange(todayDateString())).toBe(true);
	});

	it("7 日前は範囲内", () => {
		const d = new Date(Date.now() + 9 * 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000);
		const dateStr = d.toISOString().slice(0, 10);
		expect(isDateWithinRange(dateStr)).toBe(true);
	});

	it("8 日前は範囲外", () => {
		const d = new Date(Date.now() + 9 * 60 * 60 * 1000 - 8 * 24 * 60 * 60 * 1000);
		const dateStr = d.toISOString().slice(0, 10);
		expect(isDateWithinRange(dateStr)).toBe(false);
	});

	it("未来の日付は範囲外", () => {
		const d = new Date(Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
		const dateStr = d.toISOString().slice(0, 10);
		expect(isDateWithinRange(dateStr)).toBe(false);
	});
});

describe("guildIdSchema", () => {
	it("正常な snowflake ID を受け付ける", () => {
		const result = guildIdSchema.safeParse("123456789012345678");
		expect(result.success).toBe(true);
	});

	it("省略を受け付ける", () => {
		// oxlint-disable-next-line no-useless-undefined -- safeParse に明示的に undefined を渡してテスト
		const result = guildIdSchema.safeParse(undefined);
		expect(result.success).toBe(true);
	});

	it("パストラバーサル文字列を拒否する", () => {
		const result = guildIdSchema.safeParse("../../../etc/passwd");
		expect(result.success).toBe(false);
	});

	it("空文字列を拒否する", () => {
		const result = guildIdSchema.safeParse("");
		expect(result.success).toBe(false);
	});

	it("英字を含む文字列を拒否する", () => {
		const result = guildIdSchema.safeParse("abc123");
		expect(result.success).toBe(false);
	});
});
