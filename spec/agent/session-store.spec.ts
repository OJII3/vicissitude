import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import { SessionStore } from "@vicissitude/agent/session-store";
import { SqliteSessionStore } from "@vicissitude/store/session-store";

describe("@vicissitude/agent/session-store", () => {
	test("store 側の SQLite 実装を公開する", () => {
		expect(SessionStore).toBe(SqliteSessionStore);
	});

	test("store schema / raw Drizzle DB を直接参照しない", () => {
		const source = readFileSync(resolve("packages/agent/src/session-store.ts"), "utf8");
		expect(source).not.toContain("@vicissitude/store/schema");
		expect(source).not.toContain("@vicissitude/store/db");
		expect(source).not.toContain("StoreDb");
		expect(source).not.toContain("drizzle-orm");
	});
});
