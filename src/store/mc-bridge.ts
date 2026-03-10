import { and, eq, inArray, lt } from "drizzle-orm";

import type { StoreDb } from "./db.ts";
import { mcBridgeEvents, mcSessionLock } from "./schema.ts";

export type BridgeDirection = "to_discord" | "to_minecraft";
export type BridgeEventType = "command" | "report" | "lifecycle";

export interface BridgeEvent {
	id: number;
	direction: BridgeDirection;
	type: BridgeEventType;
	payload: string;
	createdAt: number;
}

/** 未消費レコードの自動パージ閾値 */
const AUTO_PURGE_THRESHOLD = 100;

/** ブリッジイベントを挿入する。未消費レコードが閾値を超えた場合は古いものを自動消費済みにする。 */
export function insertBridgeEvent(
	db: StoreDb,
	direction: BridgeDirection,
	type: BridgeEventType,
	payload: string,
): void {
	db.insert(mcBridgeEvents).values({ direction, type, payload, createdAt: Date.now() }).run();

	// 未消費レコードの肥大化を防止: 閾値超過分を消費済みにマーク
	const now = Date.now();
	if (now - lastPurgeTime > PURGE_INTERVAL_MS) {
		lastPurgeTime = now;
		db.delete(mcBridgeEvents)
			.where(and(eq(mcBridgeEvents.consumed, 1), lt(mcBridgeEvents.createdAt, now - PURGE_AGE_MS)))
			.run();
	}

	// 方向ごとの未消費レコード数を確認し、閾値を超えたら古いものを消費済みにする
	const unconsumedIds = db
		.select({ id: mcBridgeEvents.id })
		.from(mcBridgeEvents)
		.where(and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)))
		.orderBy(mcBridgeEvents.id)
		.all()
		.map((r) => r.id)
		.filter((id): id is number => id !== null);

	if (unconsumedIds.length > AUTO_PURGE_THRESHOLD) {
		const idsToMark = unconsumedIds.slice(0, unconsumedIds.length - AUTO_PURGE_THRESHOLD);
		db.update(mcBridgeEvents)
			.set({ consumed: 1 })
			.where(inArray(mcBridgeEvents.id, idsToMark))
			.run();
	}
}

/** 消費済みレコードを保持する期間（24時間） */
const PURGE_AGE_MS = 24 * 60 * 60 * 1000;

/** パージ間隔（1時間） */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 最後にパージを実行した時刻。
 * モジュールスコープの可変変数だが、パージはベストエフォートのため
 * 複数 DB インスタンスで共有されても実害はない。
 */
let lastPurgeTime = 0;

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

/** 未消費イベントをアトミックに消費する共通処理。パージは別途スロットリングして実行。 */
function consumeAndPurge(db: StoreDb, whereConditions: ReturnType<typeof and>): BridgeEvent[] {
	const rows = db.transaction((tx) => {
		const selected = tx.select().from(mcBridgeEvents).where(whereConditions).all();

		if (selected.length > 0) {
			const ids = selected.map((r) => r.id).filter((id): id is number => id !== null);
			tx.update(mcBridgeEvents).set({ consumed: 1 }).where(inArray(mcBridgeEvents.id, ids)).run();
		}

		return selected;
	});

	// 1時間に1回、消費済みの古いレコードをパージ
	const now = Date.now();
	if (now - lastPurgeTime > PURGE_INTERVAL_MS) {
		lastPurgeTime = now;
		db.delete(mcBridgeEvents)
			.where(and(eq(mcBridgeEvents.consumed, 1), lt(mcBridgeEvents.createdAt, now - PURGE_AGE_MS)))
			.run();
	}

	return rows.map((r) => toBridgeEvent(r));
}

/** 未消費のブリッジイベントをアトミックに取得し consumed=1 にする。古い消費済みレコードも削除する。 */
export function consumeBridgeEvents(db: StoreDb, direction: BridgeDirection): BridgeEvent[] {
	return consumeAndPurge(
		db,
		and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)),
	);
}

/** 未消費のブリッジイベントを消費せず覗き見する（id 昇順、limit で件数制限可能） */
export function peekBridgeEvents(
	db: StoreDb,
	direction: BridgeDirection,
	limit?: number,
): BridgeEvent[] {
	let query = db
		.select()
		.from(mcBridgeEvents)
		.where(and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)))
		.orderBy(mcBridgeEvents.id);
	if (limit !== undefined) {
		query = query.limit(limit) as typeof query;
	}
	return query.all().map((r) => toBridgeEvent(r));
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

/** セッションロック解放 + lifecycle stop イベント挿入をアトミックに実行する */
export function releaseSessionLockAndStop(db: StoreDb, guildId: string): boolean {
	return db.transaction((tx) => {
		const existing = tx.select().from(mcSessionLock).where(eq(mcSessionLock.id, 1)).get();
		if (!existing || existing.guildId !== guildId) return false;
		tx.delete(mcSessionLock).where(eq(mcSessionLock.id, 1)).run();
		tx.insert(mcBridgeEvents)
			.values({
				direction: "to_minecraft",
				type: "lifecycle",
				payload: "stop",
				createdAt: Date.now(),
			})
			.run();
		return true;
	});
}

/** セッションロックを強制クリアする（プロセス再起動時用） */
export function clearSessionLock(db: StoreDb): void {
	db.delete(mcSessionLock).run();
}
