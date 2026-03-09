import { and, eq } from "drizzle-orm";

import type { StoreDb } from "./db.ts";
import { mcBridgeEvents } from "./schema.ts";

export type BridgeDirection = "to_main" | "to_sub";

export interface BridgeEvent {
	id: number;
	direction: string;
	type: string;
	payload: string;
	createdAt: number;
}

/** ブリッジイベントを挿入する */
export function insertBridgeEvent(
	db: StoreDb,
	direction: BridgeDirection,
	type: string,
	payload: string,
): void {
	db.insert(mcBridgeEvents).values({ direction, type, payload, createdAt: Date.now() }).run();
}

/** 未消費のブリッジイベントをアトミックに取得し consumed=1 にする */
export function consumeBridgeEvents(db: StoreDb, direction: BridgeDirection): BridgeEvent[] {
	return db.transaction((tx) => {
		const rows = tx
			.select()
			.from(mcBridgeEvents)
			.where(and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)))
			.all();

		if (rows.length > 0) {
			for (const row of rows) {
				tx.update(mcBridgeEvents).set({ consumed: 1 }).where(eq(mcBridgeEvents.id, row.id)).run();
			}
		}

		return rows.map((r) => ({
			id: r.id ?? 0,
			direction: r.direction,
			type: r.type,
			payload: r.payload,
			createdAt: r.createdAt,
		}));
	});
}

/** 未消費のブリッジイベントを消費せず覗き見する */
export function peekBridgeEvents(db: StoreDb, direction: BridgeDirection): BridgeEvent[] {
	return db
		.select()
		.from(mcBridgeEvents)
		.where(and(eq(mcBridgeEvents.direction, direction), eq(mcBridgeEvents.consumed, 0)))
		.all()
		.map((r) => ({
			id: r.id ?? 0,
			direction: r.direction,
			type: r.type,
			payload: r.payload,
			createdAt: r.createdAt,
		}));
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
