import { describe, expect, it } from "bun:test";

import { CONTEXT_DIR, guildIdSchema, resolveContextPaths } from "./memory-helpers.ts";

describe("resolveContextPaths", () => {
	it("guildId 未指定時はグローバルパスを返す", () => {
		const paths = resolveContextPaths();

		expect(paths.memoryPath).toContain("context/MEMORY.md");
		expect(paths.lessonsPath).toContain("context/LESSONS.md");
		expect(paths.memoryDir).toContain("context/memory");
		expect(paths.memoryPath).not.toContain("guilds");
	});

	it("guildId 指定時は Guild 固有パスを返す", () => {
		const paths = resolveContextPaths("123456789");

		expect(paths.memoryPath).toContain("context/guilds/123456789/MEMORY.md");
		expect(paths.lessonsPath).toContain("context/guilds/123456789/LESSONS.md");
		expect(paths.memoryDir).toContain("context/guilds/123456789/memory");
	});

	it("CONTEXT_DIR をベースにしたパスを返す", () => {
		const paths = resolveContextPaths();

		expect(paths.memoryPath).toStartWith(CONTEXT_DIR);
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
