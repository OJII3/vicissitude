import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import { ContextBuilder } from "@vicissitude/agent/discord/context-builder";
import type { MemoryFact, MemoryFactReader } from "@vicissitude/shared/types";

// ─── ヘルパー ────────────────────────────────────────────────────

function createTmpDirs(): { contextDir: string; guildDataDir: string } {
	const contextDir = mkdtempSync(join(os.tmpdir(), "ctx-static-"));
	const guildDataDir = mkdtempSync(join(os.tmpdir(), "ctx-guild-"));
	return { contextDir, guildDataDir };
}

function writeFile(dir: string, relativePath: string, content: string): void {
	const fullPath = join(dir, relativePath);
	const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
	mkdirSync(parentDir, { recursive: true });
	writeFileSync(fullPath, content);
}

function createMockMemoryReader(facts: MemoryFact[]): MemoryFactReader {
	return {
		getFacts: mock(() => Promise.resolve(facts)),
		getRelevantFacts: mock(() => Promise.resolve(facts)),
		close: mock(() => Promise.resolve()),
	};
}

// ─── ContextBuilder ──────────────────────────────────────────────

describe("ContextBuilder", () => {
	describe("SHARED_FILES", () => {
		it("SHARED_FILES は IDENTITY.md, SOUL.md, DISCORD.md の3つのみ", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			writeFile(contextDir, "IDENTITY.md", "identity");
			writeFile(contextDir, "SOUL.md", "soul");
			writeFile(contextDir, "DISCORD.md", "discord");

			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build();

			expect(result).toContain("<IDENTITY.md>");
			expect(result).toContain("<SOUL.md>");
			expect(result).toContain("<DISCORD.md>");
		});

		it("contextDir からファイルを読み込む", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			writeFile(contextDir, "IDENTITY.md", "identity content");

			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build();

			expect(result).toContain("identity content");
		});
	});

	describe("Guild 固有ファイル", () => {
		it("Guild 固有の SERVER.md が guildDataDir から読み込まれる", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			writeFile(guildDataDir, "123456789/SERVER.md", "guild server info");

			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build("123456789");

			expect(result).toContain("guild server info");
		});

		it("Guild 固有ファイルがなくてもエラーにならない", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();

			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build("123456789");

			expect(result).not.toContain("<SERVER.md>");
		});
	});

	describe("Memory ファクト注入", () => {
		it("guildId ありの場合に Memory ファクトが注入される", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			const facts: MemoryFact[] = [
				{ content: "ユーザーAは猫が好き", category: "preference", createdAt: "2026-01-01" },
				{ content: "サーバー名はテスト鯖", category: "fact", createdAt: "2026-01-02" },
			];
			const reader = createMockMemoryReader(facts);

			const builder = new ContextBuilder(contextDir, guildDataDir, reader);
			const result = await builder.build("123456789");

			expect(result).toContain("<memory-facts>");
			expect(result).toContain("[preference] ユーザーAは猫が好き");
			expect(result).toContain("[fact] サーバー名はテスト鯖");
			expect(reader.getFacts).toHaveBeenCalledWith("123456789");
		});

		it("guildId なしの場合は Memory ファクトが注入されない", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			const reader = createMockMemoryReader([
				{ content: "test", category: "cat", createdAt: "2026-01-01" },
			]);

			const builder = new ContextBuilder(contextDir, guildDataDir, reader);
			const result = await builder.build();

			expect(result).not.toContain("<memory-facts>");
			expect(reader.getFacts).not.toHaveBeenCalled();
		});
	});

	describe("Memory ファクト取得の graceful degradation", () => {
		it("Memory ファクト取得で例外発生時はスキップして続行する", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			writeFile(contextDir, "IDENTITY.md", "identity content");

			const failingReader: MemoryFactReader = {
				getFacts: mock(() => Promise.reject(new Error("Memory connection failed"))),
				getRelevantFacts: mock(() => Promise.reject(new Error("Memory connection failed"))),
				close: mock(() => Promise.resolve()),
			};

			const builder = new ContextBuilder(contextDir, guildDataDir, failingReader);
			const result = await builder.build("123456789");

			expect(result).toContain("identity content");
			expect(result).not.toContain("<memory-facts>");
		});
	});

	describe("ファイルサイズ制限", () => {
		it("PER_FILE_MAX を超えるファイルが切り詰められる", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			// PER_FILE_MAX は 20_000。各ファイルに 50_000 文字書く → PER_FILE_MAX で切り詰め発動
			// 切り詰め後は約 20,030 文字/セクション × 4 = 80,120 < TOTAL_MAX (150,000) なので全ファイル収まる
			const largeContent = "x".repeat(50_000);
			writeFile(contextDir, "IDENTITY.md", largeContent);
			writeFile(contextDir, "SOUL.md", largeContent);
			writeFile(contextDir, "DISCORD.md", largeContent);
			writeFile(guildDataDir, "999/SERVER.md", largeContent);

			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build("999");

			expect(result).toContain("<IDENTITY.md>");
			const sectionCount = (result.match(/<\/(IDENTITY|SOUL|DISCORD|SERVER)\.md>/g) || []).length;
			// 全4ファイルが PER_FILE_MAX で切り詰められつつも全て収まる
			expect(result).toContain("[...truncated]");
			expect(sectionCount).toBe(4);
		});
	});

	describe("guildId バリデーション", () => {
		it("不正な guildId（パストラバーサル）でエラーをスローする", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			const builder = new ContextBuilder(contextDir, guildDataDir);
			await expect(builder.build("../../../etc")).rejects.toThrow("Invalid guildId");
		});

		it("不正な guildId（英字）でエラーをスローする", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			const builder = new ContextBuilder(contextDir, guildDataDir);
			await expect(builder.build("abc")).rejects.toThrow("Invalid guildId");
		});

		it("正しい guildId（数字のみ）は通る", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();
			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build("123456789");
			expect(result).toContain("current_guild_id: 123456789");
		});
	});

	describe("guild-context セクション", () => {
		it("guildId ありの場合に guild-context が付与される", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();

			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build("987654321");

			expect(result).toContain("<guild-context>");
			expect(result).toContain("current_guild_id: 987654321");
		});

		it("guildId なしの場合は guild-context が付与されない", async () => {
			const { contextDir, guildDataDir } = createTmpDirs();

			const builder = new ContextBuilder(contextDir, guildDataDir);
			const result = await builder.build();

			expect(result).not.toContain("<guild-context>");
		});
	});
});
