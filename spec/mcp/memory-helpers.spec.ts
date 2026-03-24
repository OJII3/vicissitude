import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { readWithFallbackFrom } from "@vicissitude/mcp/memory-helpers";

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
