import { and, eq, inArray, lt } from "drizzle-orm";

import type { StoreDb } from "./db.ts";
import { mcBridgeEvents, mcSessionLock } from "./schema.ts";

export type BridgeDirection = "to_main" | "to_sub";
export type BridgeEventType = "command" | "report" | "lifecycle";

export interface BridgeEvent {
	id: number;
	direction: BridgeDirection;
	type: BridgeEventType;
	payload: string;
	createdAt: number;
}

/** ブリッジイベントを挿入する */
export function insertBridgeEvent(
	db: StoreDb,
	direction: BridgeDirection,
	type: BridgeEventType,
	payload: string,
): void {
	db.insert(mcBridgeEvents).values({ direction, type, payload, createdAt: Date.now() }).run();
}

/** 消費済みレコードを保持する期間（24時間） */
const PURGE_AGE_MS = 24 * 60 * 60 * 1000;

/** DB 行を BridgeEvent に変換するヘルパー */
function toBridgeEvent(r: {
	id: number | null;
	direction: string;
	type: string;
	payload: string;
	createdAt: number;
}): BridgeEvent {
	return {
		id: r.id ?? 0,
		direction: r.direction as BridgeDirection,
		type: r.type as BridgeEventType,
		payload: r.payload,
		createdAt: r.createdAt,
	};
}

/** 未消費イベントをアトミックに消費し、古い消費済みレコードをパージする共通処理 */
function consumeAndPurge(db: StoreDb, whereConditions: ReturnType<typeof and>): BridgeEvent[] {
	return db.transaction((tx) => {
		const rows = tx.select().from(mcBridgeEvents).where(whereConditions).all();

		if (rows.length > 0) {
			const ids = rows.map((r) => r.id).filter((id): id is number => id !== null);
			tx.update(mcBridgeEvents).set({ consumed: 1 }).where(inArray(mcBridgeEvents.id, ids)).run();
		}

		// 24時間以上前の消費済みレコードをパージ
		tx.delete(mcBridgeEvents)
			.where(
				and(
					eq(mcBridgeEvents.consumed, 1),
					lt(mcBridgeEvents.createdAt, Date.now() - PURGE_AGE_MS),
				),
			)
			.run();

		return rows.map((r) => toBridgeEvent(r));
	});
}

/** 未消費のブリッジイベントをアトミックに取得し consumed=1 にする。古い消費済みレコードも削除する。 */
export function consumeBridgeEvents(db: StoreDb, direction: BridgeDirection): BridgeEvent[] {
	return consumeAndPurge(
		db,
		and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)),
	);
}

/** 未消費のブリッジイベントを消費せず覗き見する */
export function peekBridgeEvents(db: StoreDb, direction: BridgeDirection): BridgeEvent[] {
	return db
		.select()
		.from(mcBridgeEvents)
		.where(and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)))
		.all()
		.map((r) => toBridgeEvent(r));
}

/** 未消費の特定タイプのブリッジイベントをアトミックに取得し consumed=1 にする。古い消費済みレコードも削除する。 */
export function consumeBridgeEventsByType(
	db: StoreDb,
	direction: BridgeDirection,
	type: BridgeEventType,
): BridgeEvent[] {
	return consumeAndPurge(
		db,
		and(
			eq(mcBridgeEvents.direction, direction),
			eq(mcBridgeEvents.type, type),
			eq(mcBridgeEvents.consumed, 0),
		),
	);
}

/** 未消費のブリッジイベントが存在するか確認する */
export function hasBridgeEvents(db: StoreDb, direction: BridgeDirection): boolean {
	const row = db
		.select({ id: mcBridgeEvents.id })
		.from(mcBridgeEvents)
		.where(and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)))
		.limit(1)
		.get();
	return row !== undefined;
}

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
		tx.delete(mcSessionLock).where(eq(mcSessionLock.id, 1)).run();
		return true;
	});
}

/** セッションロックを強制クリアする（プロセス再起動時用） */
export function clearSessionLock(db: StoreDb): void {
	db.delete(mcSessionLock).run();
}
