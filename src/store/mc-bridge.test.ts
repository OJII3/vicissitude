import { describe, expect, test } from "bun:test";

import {
	clearSessionLock,
	getMcConnectionStatus,
	getSessionLockGuildId,
	hasSessionLock,
	releaseSessionLock,
	setMcConnectionStatus,
	tryAcquireSessionLock,
} from "./mc-bridge.ts";
import { mcSessionLock } from "./schema.ts";
import { createTestDb } from "./test-helpers.ts";

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

		test("acquires lock via timeout when holder is expired", () => {
			const db = createTestDb();
			// 直接 DB に古いタイムスタンプを挿入（2時間超過）
			const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000 - 1;
			db.insert(mcSessionLock).values({ id: 1, guildId: "guild-1", acquiredAt: twoHoursAgo }).run();

			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: true });
		});

		test("rejects lock when holder is not yet expired", () => {
			const db = createTestDb();
			// 1時間前 — まだタイムアウトしていない
			const oneHourAgo = Date.now() - 60 * 60 * 1000;
			db.insert(mcSessionLock).values({ id: 1, guildId: "guild-1", acquiredAt: oneHourAgo }).run();

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
			// ロックがクリアされたので再取得可能
			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: true });
		});

		test("does not throw when no lock exists", () => {
			const db = createTestDb();
			expect(() => clearSessionLock(db)).not.toThrow();
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
			// ロックがない場合は例外なく何もしない
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
			// connectedAt は切断時にも保持される（最後の接続時刻）
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

		test("returns false when lock is expired", () => {
			const db = createTestDb();
			const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000 - 1;
			db.insert(mcSessionLock).values({ id: 1, guildId: "guild-1", acquiredAt: twoHoursAgo }).run();
			expect(hasSessionLock(db)).toBe(false);
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
