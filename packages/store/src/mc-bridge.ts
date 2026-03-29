import { eq } from "drizzle-orm";

import type { StoreDb } from "./db.ts";
import { mcSessionLock } from "./schema.ts";

// ─── MC セッション排他ロック ─────────────────────────────────────

export type LockResult = { ok: true } | { ok: false; holder: string };

/** ロックタイムアウト（2時間） */
const LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** セッションロックの取得を試みる */
export function tryAcquireSessionLock(db: StoreDb, guildId: string): LockResult {
	return db.transaction((tx) => {
		const existing = tx.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();

		if (!existing) {
			tx.insert(mcSessionLock).values({ id: 1, guildId, acquiredAt: Date.now() }).run();
			return { ok: true as const };
		}

		if (existing.guildId === guildId) {
			tx.update(mcSessionLock).set({ acquiredAt: Date.now() }).where(eq(mcSessionLock.id, 1)).run();
			return { ok: true as const };
		}

		if (Date.now() - existing.acquiredAt > LOCK_TIMEOUT_MS) {
			tx.update(mcSessionLock)
				.set({ guildId, acquiredAt: Date.now() })
				.where(eq(mcSessionLock.id, 1))
				.run();
			return { ok: true as const };
		}

		return { ok: false as const, holder: existing.guildId };
	});
}

/** セッションロックを解放する。自分のロックでなければ false を返す。 */
export function releaseSessionLock(db: StoreDb, guildId: string): boolean {
	return db.transaction((tx) => {
		const existing = tx.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();
		if (!existing || existing.guildId !== guildId) return false;
		tx.update(mcSessionLock)
			.set({ guildId: "", acquiredAt: 0 })
			.where(eq(mcSessionLock.id, 1))
			.run();
		return true;
	});
}

/** セッションロックを強制クリアする（プロセス再起動時用） */
export function clearSessionLock(db: StoreDb): void {
	const existing = db.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();
	if (!existing) return;
	db.update(mcSessionLock)
		.set({ guildId: "", connected: 0, connectedAt: null, acquiredAt: 0 })
		.where(eq(mcSessionLock.id, 1))
		.run();
}

// ─── MC 接続状態 ─────────────────────────────────────────────────

/** MC Bot の接続状態を更新する */
export function setMcConnectionStatus(db: StoreDb, connected: boolean): void {
	const existing = db.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();
	if (!existing) return;
	db.update(mcSessionLock)
		.set({
			connected: connected ? 1 : 0,
			connectedAt: connected ? Date.now() : existing.connectedAt,
		})
		.where(eq(mcSessionLock.id, 1))
		.run();
}

/** MC Bot の接続状態を取得する */
export function getMcConnectionStatus(db: StoreDb): { connected: boolean; since: string | null } {
	const row = db.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();
	if (!row) return { connected: false, since: null };
	return {
		connected: row.connected === 1,
		since: row.connectedAt ? new Date(row.connectedAt).toISOString() : null,
	};
}

/** セッションロックが存在するか（MC エージェントが起動すべきか）を確認する */
export function hasSessionLock(db: StoreDb): boolean {
	const row = db.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();
	if (!row) return false;
	// タイムアウトしたロックは無効とみなす
	return Date.now() - row.acquiredAt <= LOCK_TIMEOUT_MS;
}

/** セッションロックの guildId を取得する */
export function getSessionLockGuildId(db: StoreDb): string | null {
	const row = db.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();
	// oxlint-disable-next-line typescript/prefer-nullish-coalescing -- 空文字列も null として扱う意図
	return row?.guildId || null;
}
