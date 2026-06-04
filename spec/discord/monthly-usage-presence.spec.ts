import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";

import {
	formatUsagePercentage,
	readCurrentMonthCost,
	resolveDefaultOpencodeDbPath,
} from "../../apps/discord/src/monthly-usage-presence.ts";

const tempDir = resolve(".tmp/monthly-usage-presence-spec");

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function createDb(name: string, schema: string): string {
	mkdirSync(tempDir, { recursive: true });
	const dbPath = join(tempDir, name);
	const db = new Database(dbPath);
	for (const statement of schema
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean)) {
		db.query(statement).run();
	}
	db.close();
	return dbPath;
}

describe("monthly usage presence", () => {
	it("current month の session.cost だけを合計する（Unix ms）", () => {
		const dbPath = createDb(
			"unix-ms.db",
			`
CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, time INTEGER);
INSERT INTO session VALUES ('prev', 12.5, 1706745600000);
INSERT INTO session VALUES ('current-1', 10, 1709251200000);
INSERT INTO session VALUES ('current-2', 5.25, 1711843200000);
INSERT INTO session VALUES ('next', 99, 1711929600000);
`,
		);

		expect(readCurrentMonthCost(dbPath, new Date("2024-03-15T00:00:00.000Z"))).toBe(15.25);
	});

	it("OpenCode v1.15.5 の time_created で current month の session.cost を合計する", () => {
		const dbPath = createDb(
			"opencode-time-created.db",
			`
CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL NOT NULL DEFAULT 0, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
INSERT INTO session VALUES ('prev', 12.5, 1706745600000, 1706745600000);
INSERT INTO session VALUES ('current-1', 10, 1709251200000, 1709251200000);
INSERT INTO session VALUES ('current-2', 5.25, 1711843200000, 1711843200000);
INSERT INTO session VALUES ('next', 99, 1711929600000, 1711929600000);
`,
		);

		expect(readCurrentMonthCost(dbPath, new Date("2024-03-15T00:00:00.000Z"))).toBe(15.25);
	});

	it("current month の session.cost だけを合計する（ISO text）", () => {
		const dbPath = createDb(
			"iso.db",
			`
CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, created_at TEXT);
INSERT INTO session VALUES ('prev', 12.5, '2024-02-29T23:59:59.000Z');
INSERT INTO session VALUES ('current', 7.5, '2024-03-01T00:00:00.000Z');
INSERT INTO session VALUES ('next', 99, '2024-04-01T00:00:00.000Z');
`,
		);

		expect(readCurrentMonthCost(dbPath, new Date("2024-03-15T00:00:00.000Z"))).toBe(7.5);
	});

	it("usage percentage は低い値だけ小数 1 桁で表示する", () => {
		expect(formatUsagePercentage(8.75)).toBe("8.8%");
		expect(formatUsagePercentage(12.3)).toBe("12%");
	});

	it("OpenCode DB の既定 path は XDG_DATA_HOME を優先する", () => {
		expect(
			resolveDefaultOpencodeDbPath({
				XDG_DATA_HOME: "/tmp/xdg-data",
				HOME: "/tmp/home",
			} as NodeJS.ProcessEnv),
		).toBe("/tmp/xdg-data/opencode/opencode.db");
	});

	it("XDG_DATA_HOME が無ければ HOME 配下の .local/share を使う", () => {
		expect(
			resolveDefaultOpencodeDbPath({
				HOME: "/tmp/home",
			} as NodeJS.ProcessEnv),
		).toBe("/tmp/home/.local/share/opencode/opencode.db");
	});
});
