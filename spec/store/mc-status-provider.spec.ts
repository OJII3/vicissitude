import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { setMcConnectionStatus, tryAcquireSessionLock } from "@vicissitude/store/mc-bridge";
import { SqliteMcStatusProvider } from "@vicissitude/store/mc-status-provider";
import { createTestDb } from "../../packages/store/src/test-helpers.ts";

function createTmpDir(): string {
	const dir = join(tmpdir(), `mc-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("SqliteMcStatusProvider", () => {
	test("returns null when no connection info and no goals file", async () => {
		const db = createTestDb();
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);
		expect(await provider.getStatusSummary()).toBeNull();
	});

	test("shows connected status when connected is true", async () => {
		const db = createTestDb();
		tryAcquireSessionLock(db, "guild-1");
		setMcConnectionStatus(db, true);
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("## 接続状態");
		expect(summary).toContain("接続中");
	});

	test("shows disconnected status when connected is false after being connected", async () => {
		const db = createTestDb();
		tryAcquireSessionLock(db, "guild-1");
		setMcConnectionStatus(db, true);
		setMcConnectionStatus(db, false);
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("未接続");
	});

	test("omits connection section when never connected (since is null)", async () => {
		const db = createTestDb();
		tryAcquireSessionLock(db, "guild-1");
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toBeNull();
	});

	test("reads goals from overlay path first", async () => {
		const dir = createTmpDir();
		const overlayPath = join(dir, "overlay-goals.md");
		const basePath = join(dir, "base-goals.md");
		writeFileSync(overlayPath, "# Overlay Goals\n- mine diamonds");
		writeFileSync(basePath, "# Base Goals\n- build house");

		const db = createTestDb();
		const provider = new SqliteMcStatusProvider(db, overlayPath, basePath);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("Overlay Goals");
		expect(summary).not.toContain("Base Goals");
	});

	test("falls back to base goals when overlay does not exist", async () => {
		const dir = createTmpDir();
		const basePath = join(dir, "base-goals.md");
		writeFileSync(basePath, "# Base Goals\n- build house");

		const db = createTestDb();
		const provider = new SqliteMcStatusProvider(db, "/nonexistent/overlay.md", basePath);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("Base Goals");
	});

	test("combines connection status and goals sections", async () => {
		const dir = createTmpDir();
		const goalsPath = join(dir, "goals.md");
		writeFileSync(goalsPath, "# Goals\n- find diamonds");

		const db = createTestDb();
		tryAcquireSessionLock(db, "guild-1");
		setMcConnectionStatus(db, true);

		const provider = new SqliteMcStatusProvider(db, goalsPath, "/nonexistent/base.md");

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("## 接続状態");
		expect(summary).toContain("## 現在の目標");
		expect(summary).toContain("find diamonds");
	});
});
