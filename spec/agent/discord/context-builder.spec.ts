import { describe, expect, it } from "bun:test";
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

function createMockFactReader(facts: MemoryFact[]): MemoryFactReader {
	return {
		getFacts: () => Promise.resolve(facts),
		getRelevantFacts: () => Promise.resolve(facts),
		close: () => Promise.resolve(),
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

	describe("セクションの並び順", () => {
		it("primacy-recency effect を考慮した正しい順序で並ぶ", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");
			writeFile(baseDir, "SOUL.md", "soul");
			writeFile(baseDir, "DISCORD.md", "discord");
			writeFile(baseDir, "HEARTBEAT.md", "heartbeat");
			writeFile(baseDir, "TOOLS-CORE.md", "tools-core");
			writeFile(baseDir, "TOOLS-CODE.md", "tools-code");
			writeFile(baseDir, "TOOLS-MINECRAFT.md", "tools-minecraft");
			writeFile(overlayDir, "guilds/111/SERVER.md", "server");
			writeFile(overlayDir, "guilds/111/MEMORY.md", "memory");
			writeFile(overlayDir, "guilds/111/LESSONS.md", "lessons");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("111");

			const expectedOrder = [
				"<IDENTITY.md>",
				"<SOUL.md>",
				"<LESSONS.md>",
				"<MEMORY.md>",
				"<DISCORD.md>",
				"<HEARTBEAT.md>",
				"<guild-context>",
				"<SERVER.md>",
				"<TOOLS-CORE.md>",
				"<TOOLS-CODE.md>",
				"<TOOLS-MINECRAFT.md>",
			];

			let lastIndex = -1;
			for (const tag of expectedOrder) {
				const idx = result.indexOf(tag);
				expect(idx).toBeGreaterThan(lastIndex);
				lastIndex = idx;
			}
		});
	});

	describe("TOTAL_MAX による切り詰め", () => {
		it("TOTAL_MAX を超えるとそれ以降のセクションが省略される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			// TOTAL_MAX は 150_000。各ファイルにラージコンテンツを書いて総量を超過させる
			// PER_FILE_MAX は 20_000 なので、各ファイルに 20_000 文字書く → 10 files × 20_000 = 200_000 > 150_000
			const largeContent = "x".repeat(20_000);
			writeFile(baseDir, "IDENTITY.md", largeContent);
			writeFile(baseDir, "SOUL.md", largeContent);
			writeFile(baseDir, "DISCORD.md", largeContent);
			writeFile(baseDir, "HEARTBEAT.md", largeContent);
			writeFile(baseDir, "TOOLS-CORE.md", largeContent);
			writeFile(baseDir, "TOOLS-CODE.md", largeContent);
			writeFile(baseDir, "TOOLS-MINECRAFT.md", largeContent);
			writeFile(overlayDir, "guilds/999/SERVER.md", largeContent);
			writeFile(overlayDir, "guilds/999/MEMORY.md", largeContent);
			writeFile(overlayDir, "guilds/999/LESSONS.md", largeContent);

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("999");

			expect(result.length).toBeLessThanOrEqual(160_000);
			expect(result).toContain("<IDENTITY.md>");
			const sectionCount = (
				result.match(
					/<\/(IDENTITY|SOUL|DISCORD|HEARTBEAT|TOOLS-CORE|TOOLS-CODE|TOOLS-MINECRAFT|SERVER|MEMORY|LESSONS)\.md>/g,
				) ?? []
			).length;
			expect(sectionCount).toBeLessThan(10);
		});
	});

	describe("guildId バリデーション", () => {
		it("不正な guildId（パストラバーサル）でエラーをスローする", () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			expect(builder.build("../../../etc")).rejects.toThrow("Invalid guildId");
		});

		it("不正な guildId（英字）でエラーをスローする", () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			expect(builder.build("abc")).rejects.toThrow("Invalid guildId");
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

	describe("excludeFiles オプション", () => {
		it("excludeFiles に指定したファイルが出力から除外される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");
			writeFile(baseDir, "SOUL.md", "soul");
			writeFile(baseDir, "DISCORD.md", "discord");
			writeFile(baseDir, "TOOLS-MINECRAFT.md", "tools-minecraft");

			const excludeFiles = new Set(["TOOLS-MINECRAFT.md", "DISCORD.md"]);
			const builder = new ContextBuilder(overlayDir, baseDir, undefined, excludeFiles);
			const result = await builder.build();

			expect(result).toContain("<IDENTITY.md>");
			expect(result).toContain("<SOUL.md>");
			expect(result).not.toContain("<TOOLS-MINECRAFT.md>");
			expect(result).not.toContain("<DISCORD.md>");
		});

		it("excludeFiles が空セットの場合は全ファイルが含まれる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");
			writeFile(baseDir, "SOUL.md", "soul");
			writeFile(baseDir, "TOOLS-MINECRAFT.md", "tools-minecraft");

			const builder = new ContextBuilder(overlayDir, baseDir, undefined, new Set());
			const result = await builder.build();

			expect(result).toContain("<IDENTITY.md>");
			expect(result).toContain("<SOUL.md>");
			expect(result).toContain("<TOOLS-MINECRAFT.md>");
		});

		it("excludeFiles に存在しないファイル名を指定してもエラーにならない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");

			const excludeFiles = new Set(["NON-EXISTENT.md", "ANOTHER-FAKE.md"]);
			const builder = new ContextBuilder(overlayDir, baseDir, undefined, excludeFiles);
			const result = await builder.build();

			expect(result).toContain("<IDENTITY.md>");
		});

		it("excludeFiles と factReader を併用できる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");
			writeFile(baseDir, "TOOLS-MINECRAFT.md", "tools-minecraft");

			const factReader = createMockFactReader([
				{
					content: "テストファクト",
					category: "preference",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			]);

			const excludeFiles = new Set(["TOOLS-MINECRAFT.md"]);
			const builder = new ContextBuilder(overlayDir, baseDir, factReader, excludeFiles);
			const result = await builder.build("111");

			expect(result).toContain("<IDENTITY.md>");
			expect(result).toContain("<MEMORY-FACTS>");
			expect(result).not.toContain("<TOOLS-MINECRAFT.md>");
		});
	});

	describe("MemoryFactReader 連携", () => {
		it("factReader が渡された場合に MEMORY-FACTS セクションが含まれる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");

			const factReader = createMockFactReader([
				{
					content: "コーヒーが好き",
					category: "preference",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
				{
					content: "TypeScript が得意",
					category: "interest",
					createdAt: "2026-01-02T00:00:00.000Z",
				},
			]);

			const builder = new ContextBuilder(overlayDir, baseDir, factReader);
			const result = await builder.build("111");

			expect(result).toContain("<MEMORY-FACTS>");
			expect(result).toContain("コーヒーが好き");
			expect(result).toContain("TypeScript が得意");
			expect(result).toContain("</MEMORY-FACTS>");
		});

		it("factReader が渡されない場合は MEMORY-FACTS セクションが含まれない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("111");

			expect(result).not.toContain("<MEMORY-FACTS>");
			expect(result).not.toContain("</MEMORY-FACTS>");
		});

		it("guideline カテゴリのファクトが「行動ガイドライン」セクションとして先頭にグルーピングされる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");

			const factReader = createMockFactReader([
				{ content: "丁寧語を使う", category: "guideline", createdAt: "2026-01-01T00:00:00.000Z" },
				{ content: "挨拶は元気よく", category: "guideline", createdAt: "2026-01-02T00:00:00.000Z" },
				{
					content: "コーヒーが好き",
					category: "preference",
					createdAt: "2026-01-03T00:00:00.000Z",
				},
				{ content: "ゲームが趣味", category: "interest", createdAt: "2026-01-04T00:00:00.000Z" },
			]);

			const builder = new ContextBuilder(overlayDir, baseDir, factReader);
			const result = await builder.build("111");

			expect(result).toContain("行動ガイドライン");

			// guideline セクションが他のファクトより前に配置される
			const guidelineIdx = result.indexOf("行動ガイドライン");
			const preferenceIdx = result.indexOf("コーヒーが好き");
			const interestIdx = result.indexOf("ゲームが趣味");
			expect(guidelineIdx).toBeGreaterThan(-1);
			expect(guidelineIdx).toBeLessThan(preferenceIdx);
			expect(guidelineIdx).toBeLessThan(interestIdx);
		});

		it("MEMORY-FACTS は SESSION-SUMMARY.md の後、DISCORD.md の前に配置される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");
			writeFile(baseDir, "SOUL.md", "soul");
			writeFile(baseDir, "DISCORD.md", "discord");
			writeFile(overlayDir, "guilds/111/SESSION-SUMMARY.md", "session summary");

			const factReader = createMockFactReader([
				{
					content: "テストファクト",
					category: "preference",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			]);

			const builder = new ContextBuilder(overlayDir, baseDir, factReader);
			const result = await builder.build("111");

			const sessionSummaryEnd = result.indexOf("</SESSION-SUMMARY.md>");
			const memoryFactsStart = result.indexOf("<MEMORY-FACTS>");
			const discordStart = result.indexOf("<DISCORD.md>");

			expect(sessionSummaryEnd).toBeGreaterThan(-1);
			expect(memoryFactsStart).toBeGreaterThan(-1);
			expect(discordStart).toBeGreaterThan(-1);

			expect(memoryFactsStart).toBeGreaterThan(sessionSummaryEnd);
			expect(memoryFactsStart).toBeLessThan(discordStart);
		});

		it("ファクトが空の場合は MEMORY-FACTS セクションが含まれない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");

			const factReader = createMockFactReader([]);

			const builder = new ContextBuilder(overlayDir, baseDir, factReader);
			const result = await builder.build("111");

			expect(result).not.toContain("<MEMORY-FACTS>");
		});

		it("guildId なしの場合は factReader があっても MEMORY-FACTS が含まれない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");

			const factReader = createMockFactReader([
				{
					content: "テストファクト",
					category: "preference",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			]);

			const builder = new ContextBuilder(overlayDir, baseDir, factReader);
			const result = await builder.build();

			// guildId がないため getFacts は空を返す想定
			expect(result).not.toContain("<MEMORY-FACTS>");
		});
	});
});
