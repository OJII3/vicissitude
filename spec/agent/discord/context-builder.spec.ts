import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import { ContextBuilder } from "@vicissitude/agent/discord/context-builder";
import type { MemoryFact, MemoryFactReader } from "@vicissitude/shared/types";

// ─── ヘルパー ────────────────────────────────────────────────────

function createTmpDirs(): { baseDir: string; overlayDir: string } {
	const baseDir = mkdtempSync(join(os.tmpdir(), "ctx-base-"));
	const overlayDir = mkdtempSync(join(os.tmpdir(), "ctx-overlay-"));
	return { baseDir, overlayDir };
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
	describe("base/overlay のファイル優先順位", () => {
		it("overlay が base を上書きする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "base identity");
			writeFile(overlayDir, "IDENTITY.md", "overlay identity");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build();

			expect(result).toContain("overlay identity");
			expect(result).not.toContain("base identity");
		});

		it("overlay にファイルがなければ base にフォールバックする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "base identity");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build();

			expect(result).toContain("base identity");
		});
	});

	describe("Guild 固有ファイル", () => {
		it("Guild 固有の SERVER.md が読み込まれる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(overlayDir, "guilds/123456789/SERVER.md", "guild server info");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");

			expect(result).toContain("guild server info");
		});

		it("Guild 固有ファイルがなくてもエラーにならない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");

			expect(result).not.toContain("<SERVER.md>");
		});
	});

	describe("Memory ファクト注入", () => {
		it("guildId ありの場合に Memory ファクトが注入される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const facts: MemoryFact[] = [
				{ content: "ユーザーAは猫が好き", category: "preference", createdAt: "2026-01-01" },
				{ content: "サーバー名はテスト鯖", category: "fact", createdAt: "2026-01-02" },
			];
			const reader = createMockMemoryReader(facts);

			const builder = new ContextBuilder(overlayDir, baseDir, reader);
			const result = await builder.build("123456789");

			expect(result).toContain("<memory-facts>");
			expect(result).toContain("[preference] ユーザーAは猫が好き");
			expect(result).toContain("[fact] サーバー名はテスト鯖");
			expect(reader.getFacts).toHaveBeenCalledWith("123456789");
		});

		it("guildId なしの場合は Memory ファクトが注入されない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const reader = createMockMemoryReader([
				{ content: "test", category: "cat", createdAt: "2026-01-01" },
			]);

			const builder = new ContextBuilder(overlayDir, baseDir, reader);
			const result = await builder.build();

			expect(result).not.toContain("<memory-facts>");
			expect(reader.getFacts).not.toHaveBeenCalled();
		});
	});

	describe("Memory ファクト取得の graceful degradation", () => {
		it("Memory ファクト取得で例外発生時はスキップして続行する", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity content");

			const failingReader: MemoryFactReader = {
				getFacts: mock(() => Promise.reject(new Error("Memory connection failed"))),
				getRelevantFacts: mock(() => Promise.reject(new Error("Memory connection failed"))),
				close: mock(() => Promise.resolve()),
			};

			const builder = new ContextBuilder(overlayDir, baseDir, failingReader);
			const result = await builder.build("123456789");

			expect(result).toContain("identity content");
			expect(result).not.toContain("<memory-facts>");
		});
	});

	describe("TOTAL_MAX による切り詰め", () => {
		it("TOTAL_MAX を超えるとそれ以降のセクションが省略される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			// TOTAL_MAX は 150_000。各 SHARED_FILE にラージコンテンツを書いて総量を超過させる
			// SHARED_FILES: IDENTITY, SOUL, DISCORD, HEARTBEAT, TOOLS-CORE, TOOLS-CODE, TOOLS-MINECRAFT (7 files)
			// GUILD_FILES: SERVER (1 file)
			// PER_FILE_MAX は 20_000 なので、各ファイルに 20_000 文字書く → 8 files × 20_000 = 160_000 > 150_000
			const largeContent = "x".repeat(20_000);
			writeFile(baseDir, "IDENTITY.md", largeContent);
			writeFile(baseDir, "SOUL.md", largeContent);
			writeFile(baseDir, "DISCORD.md", largeContent);
			writeFile(baseDir, "HEARTBEAT.md", largeContent);
			writeFile(baseDir, "TOOLS-CORE.md", largeContent);
			writeFile(baseDir, "TOOLS-CODE.md", largeContent);
			writeFile(baseDir, "TOOLS-MINECRAFT.md", largeContent);
			writeFile(overlayDir, "guilds/999/SERVER.md", largeContent);

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("999");

			expect(result.length).toBeLessThanOrEqual(160_000);
			expect(result).toContain("<IDENTITY.md>");
			const sectionCount = (
				result.match(
					/<\/(IDENTITY|SOUL|DISCORD|HEARTBEAT|TOOLS-CORE|TOOLS-CODE|TOOLS-MINECRAFT|SERVER)\.md>/g,
				) || []
			).length;
			expect(sectionCount).toBeLessThan(8);
		});
	});

	describe("guildId バリデーション", () => {
		it("不正な guildId（パストラバーサル）でエラーをスローする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			await expect(builder.build("../../../etc")).rejects.toThrow("Invalid guildId");
		});

		it("不正な guildId（英字）でエラーをスローする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			await expect(builder.build("abc")).rejects.toThrow("Invalid guildId");
		});

		it("正しい guildId（数字のみ）は通る", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");
			expect(result).toContain("current_guild_id: 123456789");
		});
	});

	describe("guild-context セクション", () => {
		it("guildId ありの場合に guild-context が付与される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("987654321");

			expect(result).toContain("<guild-context>");
			expect(result).toContain("current_guild_id: 987654321");
		});

		it("guildId なしの場合は guild-context が付与されない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build();

			expect(result).not.toContain("<guild-context>");
		});
	});
});
