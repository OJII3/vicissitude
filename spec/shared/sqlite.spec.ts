import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { hasColumn } from "@vicissitude/shared/sqlite";

describe("hasColumn", () => {
	it("returns whether a table has the requested column", () => {
		const db = new Database(":memory:");
		db.prepare("CREATE TABLE user_events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)").run();

		expect(hasColumn(db, "user_events", "payload")).toBe(true);
		expect(hasColumn(db, "user_events", "missing")).toBe(false);

		db.close();
	});

	it("rejects unsafe table identifiers before building PRAGMA SQL", () => {
		const db = new Database(":memory:");

		expect(() => hasColumn(db, "user_events; DROP TABLE user_events", "payload")).toThrow(
			"Invalid SQLite identifier",
		);

		db.close();
	});
});
