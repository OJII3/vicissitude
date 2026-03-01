import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import {
	BASE_CONTEXT_DIR,
	OVERLAY_CONTEXT_DIR,
	guildIdSchema,
	readWithFallback,
	resolveContextPaths,
} from "./memory-helpers.ts";

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

describe("readWithFallback", () => {
	const testOverlayDir = resolve(import.meta.dirname, "../../.test-fallback/overlay");
	const testBaseDir = resolve(import.meta.dirname, "../../.test-fallback/base");

	beforeEach(() => {
		mkdirSync(testOverlayDir, { recursive: true });
		mkdirSync(testBaseDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(resolve(import.meta.dirname, "../../.test-fallback"), { recursive: true, force: true });
	});

	it("overlay にファイルがあれば overlay を返す", () => {
		const overlayPath = resolve(OVERLAY_CONTEXT_DIR, "TEST_FALLBACK.md");
		const basePath = resolve(BASE_CONTEXT_DIR, "TEST_FALLBACK.md");

		try {
			mkdirSync(resolve(overlayPath, ".."), { recursive: true });
			writeFileSync(overlayPath, "overlay content", "utf-8");
			writeFileSync(basePath, "base content", "utf-8");

			const content = readWithFallback(overlayPath);
			expect(content).toBe("overlay content");
		} finally {
			try {
				rmSync(overlayPath);
			} catch {}
			try {
				rmSync(basePath);
			} catch {}
		}
	});

	it("overlay にない場合は base にフォールバックする", () => {
		const overlayPath = resolve(OVERLAY_CONTEXT_DIR, "TEST_FALLBACK2.md");
		const basePath = resolve(BASE_CONTEXT_DIR, "TEST_FALLBACK2.md");

		try {
			mkdirSync(resolve(basePath, ".."), { recursive: true });
			writeFileSync(basePath, "base content", "utf-8");

			const content = readWithFallback(overlayPath);
			expect(content).toBe("base content");
		} finally {
			try {
				rmSync(basePath);
			} catch {}
		}
	});

	it("どちらにもない場合は空文字を返す", () => {
		const overlayPath = resolve(OVERLAY_CONTEXT_DIR, "NONEXISTENT.md");
		const content = readWithFallback(overlayPath);
		expect(content).toBe("");
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
