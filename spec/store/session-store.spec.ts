import { describe, expect, test } from "bun:test";

import type { SessionStorePort } from "@vicissitude/shared/types";
import { SqliteSessionStore } from "@vicissitude/store/session-store";
import { createTestDb } from "@vicissitude/store/test-helpers";

describe("SqliteSessionStore", () => {
	test("shared の SessionStorePort として save → get を満たす", () => {
		const store: SessionStorePort = new SqliteSessionStore(createTestDb());

		store.save("agent-1", "__polling__:guild-1", "session-abc");

		expect(store.get("agent-1", "__polling__:guild-1")).toBe("session-abc");
	});

	test("get returns undefined for missing key", () => {
		const store = new SqliteSessionStore(createTestDb());

		expect(store.get("agent-1", "nonexistent")).toBeUndefined();
	});

	test("getRow returns createdAt", () => {
		const store = new SqliteSessionStore(createTestDb());

		const before = Date.now();
		store.save("agent-1", "__polling__:guild-1", "session-abc");
		const after = Date.now();

		const row = store.getRow("agent-1", "__polling__:guild-1");
		expect(row).toBeDefined();
		expect(row?.sessionId).toBe("session-abc");
		expect(row?.createdAt).toBeGreaterThanOrEqual(before);
		expect(row?.createdAt).toBeLessThanOrEqual(after);
	});

	test("getRow returns undefined for missing key", () => {
		const store = new SqliteSessionStore(createTestDb());

		expect(store.getRow("agent-1", "nonexistent")).toBeUndefined();
	});

	test("delete removes session", () => {
		const store = new SqliteSessionStore(createTestDb());

		store.save("agent-1", "__polling__:guild-1", "session-abc");
		expect(store.get("agent-1", "__polling__:guild-1")).toBe("session-abc");

		store.delete("agent-1", "__polling__:guild-1");
		expect(store.get("agent-1", "__polling__:guild-1")).toBeUndefined();
		expect(store.count()).toBe(0);
	});

	test("save overwrites existing session", () => {
		const store = new SqliteSessionStore(createTestDb());

		store.save("agent-1", "__polling__:guild-1", "session-old");
		store.save("agent-1", "__polling__:guild-1", "session-new");

		expect(store.get("agent-1", "__polling__:guild-1")).toBe("session-new");
		expect(store.count()).toBe(1);
	});

	test("count returns 0 for empty store", () => {
		const store = new SqliteSessionStore(createTestDb());

		expect(store.count()).toBe(0);
	});

	test("multiple agents with different keys are independent", () => {
		const store = new SqliteSessionStore(createTestDb());

		store.save("agent-1", "__polling__:guild-1", "session-1");
		store.save("agent-2", "__polling__:guild-1", "session-2");
		store.save("agent-1", "__polling__:guild-2", "session-3");

		expect(store.get("agent-1", "__polling__:guild-1")).toBe("session-1");
		expect(store.get("agent-2", "__polling__:guild-1")).toBe("session-2");
		expect(store.get("agent-1", "__polling__:guild-2")).toBe("session-3");
		expect(store.count()).toBe(3);
	});
});
