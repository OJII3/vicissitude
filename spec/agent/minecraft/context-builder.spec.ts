import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import { MinecraftContextBuilder } from "../../../src/agent/minecraft/context-builder.ts";

function createTmpDirs(): { baseDir: string; overlayDir: string } {
	const baseDir = mkdtempSync(join(os.tmpdir(), "mc-ctx-base-"));
	const overlayDir = mkdtempSync(join(os.tmpdir(), "mc-ctx-overlay-"));
	return { baseDir, overlayDir };
}

function writeFile(dir: string, relativePath: string, content: string): void {
	const fullPath = join(dir, relativePath);
	const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
	mkdirSync(parentDir, { recursive: true });
	writeFileSync(fullPath, content);
}

describe("MinecraftContextBuilder", () => {
	it("overlay が base を上書きする", async () => {
		const { baseDir, overlayDir } = createTmpDirs();
		writeFile(baseDir, "MINECRAFT-IDENTITY.md", "base identity");
		writeFile(overlayDir, "MINECRAFT-IDENTITY.md", "overlay identity");

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const result = await builder.build();

		expect(result).toContain("overlay identity");
		expect(result).not.toContain("base identity");
	});

	it("overlay にファイルがなければ base にフォールバックする", async () => {
		const { baseDir, overlayDir } = createTmpDirs();
		writeFile(baseDir, "MINECRAFT-IDENTITY.md", "base identity");

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const result = await builder.build();

		expect(result).toContain("base identity");
	});

	it("どちらにもファイルがなければ空文字列を返す", async () => {
		const { baseDir, overlayDir } = createTmpDirs();

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const result = await builder.build();

		expect(result).toBe("");
	});

	it("guildId 引数が無視される（Guild 非依存）", async () => {
		const { baseDir, overlayDir } = createTmpDirs();
		writeFile(baseDir, "MINECRAFT-IDENTITY.md", "mc identity");

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const withGuild = await builder.build("123456789");
		const withoutGuild = await builder.build();

		expect(withGuild).toBe(withoutGuild);
	});

	it("XML タグでラップされる", async () => {
		const { baseDir, overlayDir } = createTmpDirs();
		writeFile(baseDir, "MINECRAFT-IDENTITY.md", "identity content");
		writeFile(baseDir, "MINECRAFT-KNOWLEDGE.md", "knowledge content");

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const result = await builder.build();

		expect(result).toContain("<MINECRAFT-IDENTITY.md>");
		expect(result).toContain("</MINECRAFT-IDENTITY.md>");
		expect(result).toContain("<MINECRAFT-KNOWLEDGE.md>");
		expect(result).toContain("</MINECRAFT-KNOWLEDGE.md>");
	});

	it("MINECRAFT-PROGRESS.md が注入される", async () => {
		const { baseDir, overlayDir } = createTmpDirs();
		writeFile(baseDir, "MINECRAFT-PROGRESS.md", "progress content");

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const result = await builder.build();

		expect(result).toContain("<MINECRAFT-PROGRESS.md>");
		expect(result).toContain("progress content");
		expect(result).toContain("</MINECRAFT-PROGRESS.md>");
	});

	it("MINECRAFT-SKILLS.md は注入されない（必要時のみツールで読む）", async () => {
		const { baseDir, overlayDir } = createTmpDirs();
		writeFile(baseDir, "MINECRAFT-SKILLS.md", "skills content");

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const result = await builder.build();

		expect(result).not.toContain("MINECRAFT-SKILLS.md");
		expect(result).not.toContain("skills content");
	});

	it("PER_FILE_MAX 超過時に切り詰める", async () => {
		const { baseDir, overlayDir } = createTmpDirs();
		const largeContent = "x".repeat(25_000);
		writeFile(baseDir, "MINECRAFT-IDENTITY.md", largeContent);

		const builder = new MinecraftContextBuilder(overlayDir, baseDir);
		const result = await builder.build();

		expect(result).toContain("[...truncated]");
		expect(result.length).toBeLessThan(25_000);
	});
});
