import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import { ContextBuilder } from "@vicissitude/agent/discord/context-builder";

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
				) || []
			).length;
			expect(sectionCount).toBeLessThan(10);
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
