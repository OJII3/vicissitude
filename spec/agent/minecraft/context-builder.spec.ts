import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import { MinecraftContextBuilder } from "@vicissitude/agent/minecraft/context-builder";

function createTmpDirs(): { dataDir: string; staticDir: string } {
	const dataDir = mkdtempSync(join(os.tmpdir(), "mc-ctx-data-"));
	const staticDir = mkdtempSync(join(os.tmpdir(), "mc-ctx-static-"));
	return { dataDir, staticDir };
}

function writeFile(dir: string, relativePath: string, content: string): void {
	const fullPath = join(dir, relativePath);
	const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
	mkdirSync(parentDir, { recursive: true });
	writeFileSync(fullPath, content);
}

describe("MinecraftContextBuilder", () => {
	it("data が static を上書きする", async () => {
		const { dataDir, staticDir } = createTmpDirs();
		writeFile(staticDir, "MINECRAFT-IDENTITY.md", "static identity");
		writeFile(dataDir, "MINECRAFT-IDENTITY.md", "data identity");

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const result = await builder.build();

		expect(result).toContain("data identity");
		expect(result).not.toContain("static identity");
	});

	it("data にファイルがなければ static にフォールバックする", async () => {
		const { dataDir, staticDir } = createTmpDirs();
		writeFile(staticDir, "MINECRAFT-IDENTITY.md", "static identity");

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const result = await builder.build();

		expect(result).toContain("static identity");
	});

	it("どちらにもファイルがなければ空文字列を返す", async () => {
		const { dataDir, staticDir } = createTmpDirs();

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const result = await builder.build();

		expect(result).toBe("");
	});

	it("guildId 引数が無視される（Guild 非依存）", async () => {
		const { dataDir, staticDir } = createTmpDirs();
		writeFile(staticDir, "MINECRAFT-IDENTITY.md", "mc identity");

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const withGuild = await builder.build("123456789");
		const withoutGuild = await builder.build();

		expect(withGuild).toBe(withoutGuild);
	});

	it("XML タグでラップされる", async () => {
		const { dataDir, staticDir } = createTmpDirs();
		writeFile(staticDir, "MINECRAFT-IDENTITY.md", "identity content");
		writeFile(staticDir, "MINECRAFT-KNOWLEDGE.md", "knowledge content");

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const result = await builder.build();

		expect(result).toContain("<MINECRAFT-IDENTITY.md>");
		expect(result).toContain("</MINECRAFT-IDENTITY.md>");
		expect(result).toContain("<MINECRAFT-KNOWLEDGE.md>");
		expect(result).toContain("</MINECRAFT-KNOWLEDGE.md>");
	});

	it("MINECRAFT-PROGRESS.md が注入される", async () => {
		const { dataDir, staticDir } = createTmpDirs();
		writeFile(staticDir, "MINECRAFT-PROGRESS.md", "progress content");

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const result = await builder.build();

		expect(result).toContain("<MINECRAFT-PROGRESS.md>");
		expect(result).toContain("progress content");
		expect(result).toContain("</MINECRAFT-PROGRESS.md>");
	});

	it("MINECRAFT-SKILLS.md は注入されない（必要時のみツールで読む）", async () => {
		const { dataDir, staticDir } = createTmpDirs();
		writeFile(staticDir, "MINECRAFT-SKILLS.md", "skills content");

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const result = await builder.build();

		expect(result).not.toContain("MINECRAFT-SKILLS.md");
		expect(result).not.toContain("skills content");
	});

	it("PER_FILE_MAX 超過時に切り詰める", async () => {
		const { dataDir, staticDir } = createTmpDirs();
		const largeContent = "x".repeat(25_000);
		writeFile(staticDir, "MINECRAFT-IDENTITY.md", largeContent);

		const builder = new MinecraftContextBuilder(dataDir, staticDir);
		const result = await builder.build();

		expect(result).toContain("[...truncated]");
		expect(result.length).toBeLessThan(25_000);
	});
});
