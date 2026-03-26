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

// ─── SESSION-SUMMARY.md の読み込み ───────────────────────────────

describe("ContextBuilder SESSION-SUMMARY.md", () => {
	describe("SESSION-SUMMARY.md が存在する場合", () => {
		it("guildId ありかつ SESSION-SUMMARY.md が存在する場合、コンテキストに含まれる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(
				overlayDir,
				"guilds/123456789/SESSION-SUMMARY.md",
				"前回セッションでユーザーはAIについて質問していた。",
			);

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");

			expect(result).toContain("<SESSION-SUMMARY.md>");
			expect(result).toContain("前回セッションでユーザーはAIについて質問していた。");
			expect(result).toContain("</SESSION-SUMMARY.md>");
		});

		it("SESSION-SUMMARY.md が存在しない場合、エラーにならず結果に SESSION-SUMMARY.md タグが含まれない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");

			expect(result).not.toContain("<SESSION-SUMMARY.md>");
		});

		it("guildId なしの場合は SESSION-SUMMARY.md が含まれない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			// guild スコープのファイルなので overlayDir 直下には置かない
			writeFile(overlayDir, "guilds/123456789/SESSION-SUMMARY.md", "session summary");

			const builder = new ContextBuilder(overlayDir, baseDir);
			// guildId なしで build
			const result = await builder.build();

			expect(result).not.toContain("<SESSION-SUMMARY.md>");
		});
	});

	describe("SESSION-SUMMARY.md の並び順（MEMORY.md の直後）", () => {
		it("SESSION-SUMMARY.md は MEMORY.md の直後に配置される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");
			writeFile(overlayDir, "guilds/111/MEMORY.md", "memory content");
			writeFile(overlayDir, "guilds/111/SESSION-SUMMARY.md", "session summary content");
			writeFile(baseDir, "DISCORD.md", "discord");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("111");

			const memoryIdx = result.indexOf("<MEMORY.md>");
			const summaryIdx = result.indexOf("<SESSION-SUMMARY.md>");
			const discordIdx = result.indexOf("<DISCORD.md>");

			expect(memoryIdx).toBeGreaterThan(-1);
			expect(summaryIdx).toBeGreaterThan(memoryIdx);
			// SESSION-SUMMARY.md は DISCORD.md より前
			if (discordIdx > -1) {
				expect(summaryIdx).toBeLessThan(discordIdx);
			}
		});

		it("全ファイルが揃っている場合、SESSION-SUMMARY.md は正しい位置に配置される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity");
			writeFile(baseDir, "SOUL.md", "soul");
			writeFile(baseDir, "DISCORD.md", "discord");
			writeFile(baseDir, "HEARTBEAT.md", "heartbeat");
			writeFile(baseDir, "TOOLS-CORE.md", "tools-core");
			writeFile(overlayDir, "guilds/111/LESSONS.md", "lessons");
			writeFile(overlayDir, "guilds/111/MEMORY.md", "memory");
			writeFile(overlayDir, "guilds/111/SESSION-SUMMARY.md", "session summary");
			writeFile(overlayDir, "guilds/111/SERVER.md", "server");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("111");

			// 期待する順序: MEMORY.md → SESSION-SUMMARY.md → DISCORD.md
			const expectedOrder = ["<MEMORY.md>", "<SESSION-SUMMARY.md>", "<DISCORD.md>"];

			let lastIndex = -1;
			for (const tag of expectedOrder) {
				const idx = result.indexOf(tag);
				expect(idx).toBeGreaterThan(lastIndex);
				lastIndex = idx;
			}
		});

		it("MEMORY.md が存在しない場合でも SESSION-SUMMARY.md は読み込まれる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(overlayDir, "guilds/222/SESSION-SUMMARY.md", "summary without memory");
			// MEMORY.md は作成しない

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("222");

			expect(result).toContain("<SESSION-SUMMARY.md>");
			expect(result).toContain("summary without memory");
		});
	});

	describe("異なる guild の SESSION-SUMMARY.md は分離される", () => {
		it("別の guildId では別の SESSION-SUMMARY.md が読み込まれる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(overlayDir, "guilds/111/SESSION-SUMMARY.md", "guild 111 の要約");
			writeFile(overlayDir, "guilds/222/SESSION-SUMMARY.md", "guild 222 の要約");

			const builder = new ContextBuilder(overlayDir, baseDir);

			const result111 = await builder.build("111");
			const result222 = await builder.build("222");

			expect(result111).toContain("guild 111 の要約");
			expect(result111).not.toContain("guild 222 の要約");

			expect(result222).toContain("guild 222 の要約");
			expect(result222).not.toContain("guild 111 の要約");
		});
	});
});
