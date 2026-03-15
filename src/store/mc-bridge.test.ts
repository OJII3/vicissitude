import { describe, expect, test } from "bun:test";

import {
	hasSessionLock,
	tryAcquireSessionLock,
} from "./mc-bridge.ts";
import { mcSessionLock } from "./schema.ts";
import { createTestDb } from "./test-helpers.ts";

describe("mc-bridge (internal: timeout behavior)", () => {
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

	test("hasSessionLock returns false when lock is expired", () => {
		const db = createTestDb();
		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000 - 1;
		db.insert(mcSessionLock).values({ id: 1, guildId: "guild-1", acquiredAt: twoHoursAgo }).run();
		expect(hasSessionLock(db)).toBe(false);
	});
});
