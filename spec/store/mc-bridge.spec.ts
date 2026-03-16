import { describe, expect, test } from "bun:test";

import {
	clearSessionLock,
	getMcConnectionStatus,
	getSessionLockGuildId,
	hasSessionLock,
	releaseSessionLock,
	setMcConnectionStatus,
	tryAcquireSessionLock,
} from "@vicissitude/store/mc-bridge";
import { createTestDb } from "@vicissitude/store/test-helpers";

describe("mc-bridge", () => {
	describe("tryAcquireSessionLock", () => {
		test("acquires lock when no existing lock", () => {
			const db = createTestDb();
			const result = tryAcquireSessionLock(db, "guild-1");
			expect(result).toEqual({ ok: true });
		});

		test("re-acquires lock for same guildId (idempotent)", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = tryAcquireSessionLock(db, "guild-1");
			expect(result).toEqual({ ok: true });
		});

		test("rejects lock when different guild holds it", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: false, holder: "guild-1" });
		});
	});

	describe("releaseSessionLock", () => {
		test("releases own lock", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = releaseSessionLock(db, "guild-1");
			expect(result).toBe(true);
		});

		test("returns false when no lock exists", () => {
			const db = createTestDb();
			const result = releaseSessionLock(db, "guild-1");
			expect(result).toBe(false);
		});

		test("returns false when different guild holds the lock", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = releaseSessionLock(db, "guild-2");
			expect(result).toBe(false);
		});

		test("allows re-acquisition after release", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			releaseSessionLock(db, "guild-1");
			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: true });
		});
	});

	describe("clearSessionLock", () => {
		test("clears existing lock", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			clearSessionLock(db);
			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: true });
		});

		test("does not throw when no lock exists", () => {
			const db = createTestDb();
			expect(() => clearSessionLock(db)).not.toThrow();
		});

		test("clearSessionLock 後に setMcConnectionStatus が正常に動作する", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			clearSessionLock(db);
			setMcConnectionStatus(db, true);
			const status = getMcConnectionStatus(db);
			expect(status.connected).toBe(true);
		});

		test("clearSessionLock 後に setMcConnectionStatus → tryAcquireSessionLock で接続状態が維持される", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			clearSessionLock(db);
			setMcConnectionStatus(db, true);
			tryAcquireSessionLock(db, "guild-2");
			const status = getMcConnectionStatus(db);
			expect(status.connected).toBe(true);
		});
	});

	describe("setMcConnectionStatus", () => {
		test("sets connected status to true", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			setMcConnectionStatus(db, true);
			const status = getMcConnectionStatus(db);
			expect(status.connected).toBe(true);
			expect(status.since).not.toBeNull();
		});

		test("sets connected status to false", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			setMcConnectionStatus(db, true);
			setMcConnectionStatus(db, false);
			const status = getMcConnectionStatus(db);
			expect(status.connected).toBe(false);
		});

		test("is no-op when no lock exists", () => {
			const db = createTestDb();
			expect(() => setMcConnectionStatus(db, true)).not.toThrow();
			const status = getMcConnectionStatus(db);
			expect(status.connected).toBe(false);
			expect(status.since).toBeNull();
		});

		test("connectedAt is preserved when disconnecting", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			setMcConnectionStatus(db, true);
			const statusBefore = getMcConnectionStatus(db);
			setMcConnectionStatus(db, false);
			const statusAfter = getMcConnectionStatus(db);
			expect(statusAfter.since).toBe(statusBefore.since);
		});
	});

	describe("getMcConnectionStatus", () => {
		test("returns disconnected with null since when no lock", () => {
			const db = createTestDb();
			const status = getMcConnectionStatus(db);
			expect(status.connected).toBe(false);
			expect(status.since).toBeNull();
		});

		test("returns disconnected with null since when lock exists but never connected", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const status = getMcConnectionStatus(db);
			expect(status.connected).toBe(false);
			expect(status.since).toBeNull();
		});
	});

	describe("hasSessionLock", () => {
		test("returns false when no lock", () => {
			const db = createTestDb();
			expect(hasSessionLock(db)).toBe(false);
		});

		test("returns true when lock exists", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			expect(hasSessionLock(db)).toBe(true);
		});
	});

	describe("getSessionLockGuildId", () => {
		test("returns null when no lock", () => {
			const db = createTestDb();
			expect(getSessionLockGuildId(db)).toBeNull();
		});

		test("returns guildId when lock exists", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			expect(getSessionLockGuildId(db)).toBe("guild-1");
		});
	});
});
