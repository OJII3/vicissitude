import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { FileContextLoader } from "./file-context-loader.ts";

const TEST_ROOT = resolve(import.meta.dirname, "../../../.test-context-loader");
const TEST_OVERLAY_DIR = resolve(TEST_ROOT, "overlay");
const TEST_BASE_DIR = resolve(TEST_ROOT, "base");

function writeOverlay(relativePath: string, content: string): void {
	const fullPath = resolve(TEST_OVERLAY_DIR, relativePath);
	mkdirSync(resolve(fullPath, ".."), { recursive: true });
	writeFileSync(fullPath, content, "utf-8");
}

function writeBase(relativePath: string, content: string): void {
	const fullPath = resolve(TEST_BASE_DIR, relativePath);
	mkdirSync(resolve(fullPath, ".."), { recursive: true });
	writeFileSync(fullPath, content, "utf-8");
}

beforeEach(() => {
	mkdirSync(TEST_OVERLAY_DIR, { recursive: true });
	mkdirSync(TEST_BASE_DIR, { recursive: true });
	writeBase("IDENTITY.md", "# Identity\nふあ");
	writeBase("SOUL.md", "# Soul\nおだやか");
	writeBase("MEMORY.md", "# Global Memory");
	writeBase("LESSONS.md", "# Global Lessons");
});

afterEach(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("FileContextLoader - guildId undefined (DM / フォールバック)", () => {
	it("base の MEMORY.md と LESSONS.md を読み込む", async () => {
		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR);
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Identity");
		expect(ctx).toContain("# Global Memory");
		expect(ctx).toContain("# Global Lessons");
	});

	it("guild-context タグが含まれない", async () => {
		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR);
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).not.toContain("<guild-context>");
	});
});

describe("FileContextLoader - overlay 優先", () => {
	it("overlay に MEMORY.md がある場合は base より優先される", async () => {
		writeOverlay("MEMORY.md", "# Overlay Memory");

		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR);
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Overlay Memory");
		expect(ctx).not.toContain("# Global Memory");
	});

	it("overlay にないファイルは base からフォールバックされる", async () => {
		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR);
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Identity");
		expect(ctx).toContain("# Soul");
		expect(ctx).toContain("# Global Memory");
	});

	it("overlay に SOUL.md がある場合は base より優先される", async () => {
		writeOverlay("SOUL.md", "# Overlay Soul");

		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR);
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Overlay Soul");
		expect(ctx).not.toContain("# Soul\nおだやか");
	});
});

describe("FileContextLoader - guildId 指定時", () => {
	it("Guild 固有の MEMORY.md が優先される", async () => {
		writeOverlay("guilds/123456/MEMORY.md", "# Guild Memory");

		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Guild Memory");
		expect(ctx).not.toContain("# Global Memory");
	});

	it("Guild 固有ファイルがない場合はグローバルにフォールバック", async () => {
		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR, "999999");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Global Memory");
		expect(ctx).toContain("# Global Lessons");
	});

	it("guild-context タグが含まれる", async () => {
		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("<guild-context>");
		expect(ctx).toContain("current_guild_id: 123456");
		expect(ctx).toContain('guild_id: "123456"');
	});

	it("共有ファイル（IDENTITY, SOUL）はベースから読み込まれる", async () => {
		writeOverlay("guilds/123456/MEMORY.md", "# Guild Memory");

		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Identity");
		expect(ctx).toContain("# Soul");
	});

	it("Guild 固有の日次ログが優先される", async () => {
		const today = new Date().toISOString().slice(0, 10);
		writeBase(`memory/${today}.md`, "# Global Log");
		writeOverlay(`guilds/123456/memory/${today}.md`, "# Guild Log");

		const loader = new FileContextLoader(TEST_OVERLAY_DIR, TEST_BASE_DIR, "123456");
		const ctx = await loader.loadBootstrapContext();

		expect(ctx).toContain("# Guild Log");
		expect(ctx).not.toContain("# Global Log");
	});
});
