import { desc, eq, inArray, sql } from "drizzle-orm";

import type { StoreDb } from "./db.ts";
import { emojiUsage, eventBuffer, sessions } from "./schema.ts";

/** event_buffer から該当ギルドのイベントを取得して削除する（トランザクションでアトミック） */
export function consumeEvents(
	db: StoreDb,
	guildId: string,
	limit?: number,
): { id: number; payload: string; createdAt: number }[] {
	return db.transaction((tx) => {
		let query = tx
			.select()
			.from(eventBuffer)
			.where(eq(eventBuffer.guildId, guildId))
			.orderBy(eventBuffer.id);
		if (limit !== undefined) {
			query = query.limit(limit) as typeof query;
		}
		const rows = query.all();
		if (rows.length > 0) {
			const ids = rows.map((r) => r.id).filter((id): id is number => id !== null);
			tx.delete(eventBuffer).where(inArray(eventBuffer.id, ids)).run();
		}
		return rows.map((r) => ({ id: r.id ?? 0, payload: r.payload, createdAt: r.createdAt }));
	});
}

/** event_buffer から最古の 1 件を取得して削除する */
export function consumeNextEvent(
	db: StoreDb,
	guildId: string,
): { id: number; payload: string; createdAt: number } | null {
	return db.transaction((tx) => {
		const row = tx
			.select()
			.from(eventBuffer)
			.where(eq(eventBuffer.guildId, guildId))
			.orderBy(eventBuffer.id)
			.limit(1)
			.get();
		if (!row) return null;
		tx.delete(eventBuffer).where(eq(eventBuffer.id, row.id)).run();
		return { id: row.id ?? 0, payload: row.payload, createdAt: row.createdAt };
	});
}

/** event_buffer にイベントを追加する */
export function appendEvent(db: StoreDb, guildId: string, payload: string): void {
	db.insert(eventBuffer).values({ guildId, payload, createdAt: Date.now() }).run();
}

/** セッションを取得する */
export function getSession(
	db: StoreDb,
	key: string,
): { key: string; sessionId: string; createdAt: number } | undefined {
	return db.select().from(sessions).where(eq(sessions.key, key)).get();
}

/** セッションを保存する（INSERT OR REPLACE） */
export function saveSession(db: StoreDb, key: string, sessionId: string): void {
	db.insert(sessions)
		.values({ key, sessionId, createdAt: Date.now() })
		.onConflictDoUpdate({
			target: sessions.key,
			set: { sessionId },
		})
		.run();
}

/** セッションを削除する */
export function deleteSession(db: StoreDb, key: string): void {
	db.delete(sessions).where(eq(sessions.key, key)).run();
}

/** 絵文字カウントを +1 する（UPSERT） */
export function incrementEmoji(db: StoreDb, guildId: string, emojiName: string): void {
	db.insert(emojiUsage)
		.values({ guildId, emojiName, count: 1 })
		.onConflictDoUpdate({
			target: [emojiUsage.guildId, emojiUsage.emojiName],
			set: { count: sql`${emojiUsage.count} + 1` },
		})
		.run();
}

/** event_buffer に該当ギルドのイベントが存在するか確認する */
export function hasEvents(db: StoreDb, guildId: string): boolean {
	const row = db
		.select({ id: eventBuffer.id })
		.from(eventBuffer)
		.where(eq(eventBuffer.guildId, guildId))
		.limit(1)
		.get();
	return row !== undefined;
}

/** 使用頻度トップ N の絵文字を返す */
export function getTopEmojis(
	db: StoreDb,
	guildId: string,
	limit: number,
): { emojiName: string; count: number }[] {
	return db
		.select({ emojiName: emojiUsage.emojiName, count: emojiUsage.count })
		.from(emojiUsage)
		.where(eq(emojiUsage.guildId, guildId))
		.orderBy(desc(emojiUsage.count))
		.limit(limit)
		.all();
}
