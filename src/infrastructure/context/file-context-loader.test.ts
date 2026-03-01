import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { FileContextLoader } from "./file-context-loader.ts";

const TEST_DIR = resolve(import.meta.dirname, "../../../.test-context-loader");

function writeFile(relativePath: string, content: string): void {
	const fullPath = resolve(TEST_DIR, relativePath);
	mkdirSync(resolve(fullPath, ".."), { recursive: true });
	writeFileSync(fullPath, content, "utf-8");
}

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	writeFile("IDENTITY.md", "# Identity\nふあ");
	writeFile("SOUL.md", "# Soul\nおだやか");
	writeFile("MEMORY.md", "# Global Memory");
	writeFile("LESSONS.md", "# Global Lessons");
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileContextLoader - guildId undefined (DM / フォールバック)", () => {
	it("グローバルの MEMORY.md と LESSONS.md を読み込む", async () => {
		const loader = new FileContextLoader(TEST_DIR);
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Identity");
		expect(ctx).toContain("# Global Memory");
		expect(ctx).toContain("# Global Lessons");
	});

	it("guild-context タグが含まれない", async () => {
		const loader = new FileContextLoader(TEST_DIR);
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).not.toContain("<guild-context>");
	});
});

describe("FileContextLoader - guildId 指定時", () => {
	it("Guild 固有の MEMORY.md が優先される", async () => {
		writeFile("guilds/123456/MEMORY.md", "# Guild Memory");

		const loader = new FileContextLoader(TEST_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Guild Memory");
		expect(ctx).not.toContain("# Global Memory");
	});

	it("Guild 固有ファイルがない場合はグローバルにフォールバック", async () => {
		const loader = new FileContextLoader(TEST_DIR, "999999");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Global Memory");
		expect(ctx).toContain("# Global Lessons");
	});

	it("guild-context タグが含まれる", async () => {
		const loader = new FileContextLoader(TEST_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("<guild-context>");
		expect(ctx).toContain("current_guild_id: 123456");
		expect(ctx).toContain('guild_id: "123456"');
	});

	it("共有ファイル（IDENTITY, SOUL）はグローバルから読み込まれる", async () => {
		writeFile("guilds/123456/MEMORY.md", "# Guild Memory");

		const loader = new FileContextLoader(TEST_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Identity");
		expect(ctx).toContain("# Soul");
	});

	it("Guild 固有の日次ログが優先される", async () => {
		const today = new Date().toISOString().slice(0, 10);
		writeFile(`memory/${today}.md`, "# Global Log");
		writeFile(`guilds/123456/memory/${today}.md`, "# Guild Log");

		const loader = new FileContextLoader(TEST_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Guild Log");
		expect(ctx).not.toContain("# Global Log");
	});
});
