import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { insertBridgeEvent } from "./mc-bridge.ts";
import { SqliteMcStatusProvider } from "./mc-status-provider.ts";
import { createTestDb } from "./test-helpers.ts";

function createTmpDir(): string {
	const dir = join(tmpdir(), `mc-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("SqliteMcStatusProvider", () => {
	test("returns null when no reports and no goals file", async () => {
		const db = createTestDb();
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);
		expect(await provider.getStatusSummary()).toBeNull();
	});

	test("builds report section with parsed JSON payloads", async () => {
		const db = createTestDb();
		insertBridgeEvent(
			db,
			"to_discord",
			"report",
			JSON.stringify({ message: "ダイヤ発見", importance: "high", category: "discovery" }),
		);
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("[discovery] ダイヤ発見");
	});

	test("groups danger reports separately", async () => {
		const db = createTestDb();
		insertBridgeEvent(
			db,
			"to_discord",
			"report",
			JSON.stringify({ message: "クリーパー接近", importance: "high", category: "danger" }),
		);
		insertBridgeEvent(
			db,
			"to_discord",
			"report",
			JSON.stringify({ message: "採掘完了", importance: "medium", category: "completion" }),
		);
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("⚠ 危険/緊急:");
		expect(summary).toContain("[high] クリーパー接近");
		expect(summary).toContain("直近の出来事:");
		expect(summary).toContain("[completion] 採掘完了");
	});

	test("groups stuck reports separately", async () => {
		const db = createTestDb();
		insertBridgeEvent(
			db,
			"to_discord",
			"report",
			JSON.stringify({ message: "パスが通らない", importance: "medium", category: "stuck" }),
		);
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("🔄 行き詰まり:");
		expect(summary).toContain("パスが通らない");
	});

	test("falls back to raw payload for non-report events", async () => {
		const db = createTestDb();
		insertBridgeEvent(db, "to_discord", "command", "raw payload");
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("(command) raw payload");
	});

	test("falls back to raw payload for malformed JSON reports", async () => {
		const db = createTestDb();
		insertBridgeEvent(db, "to_discord", "report", "not json");
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("(report) not json");
	});

	test("limits reports to MAX_RECENT_REPORTS (10)", async () => {
		const db = createTestDb();
		for (let i = 0; i < 15; i++) {
			insertBridgeEvent(
				db,
				"to_discord",
				"report",
				JSON.stringify({ message: `report-${String(i)}`, importance: "low" }),
			);
		}
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).not.toBeNull();
		expect(summary).toContain("report-0");
		expect(summary).toContain("report-9");
		expect(summary).not.toContain("report-10");
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

	test("combines reports and goals sections", async () => {
		const dir = createTmpDir();
		const goalsPath = join(dir, "goals.md");
		writeFileSync(goalsPath, "# Goals\n- find diamonds");

		const db = createTestDb();
		insertBridgeEvent(
			db,
			"to_discord",
			"report",
			JSON.stringify({ message: "found cave", importance: "medium" }),
		);

		const provider = new SqliteMcStatusProvider(db, goalsPath, "/nonexistent/base.md");

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("## 最新状況");
		expect(summary).toContain("## 現在の目標");
		expect(summary).toContain("found cave");
		expect(summary).toContain("find diamonds");
	});

	test("shows pending commands section", async () => {
		const db = createTestDb();
		insertBridgeEvent(db, "to_minecraft", "command", "ダイヤ5個集めて");
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		expect(summary).toContain("## 未処理の指示");
		expect(summary).toContain("ダイヤ5個集めて");
	});

	test("defaults category to status when not provided", async () => {
		const db = createTestDb();
		insertBridgeEvent(
			db,
			"to_discord",
			"report",
			JSON.stringify({ message: "一般報告", importance: "low" }),
		);
		const provider = new SqliteMcStatusProvider(
			db,
			"/nonexistent/overlay.md",
			"/nonexistent/base.md",
		);

		const summary = await provider.getStatusSummary();
		// status カテゴリはタグなしで表示される
		expect(summary).toContain("- 一般報告");
		expect(summary).not.toContain("[status]");
	});
});
