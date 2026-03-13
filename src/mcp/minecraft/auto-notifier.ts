import { METRIC } from "../../core/constants.ts";
import type { MetricsCollector } from "../../core/types.ts";
import type { StoreDb } from "../../store/db.ts";
import { insertBridgeEvent } from "../../store/mc-bridge.ts";
import type { Importance } from "./helpers.ts";

/** Discord 自動通知の対象イベント種別（report として書き込む） */
const AUTO_NOTIFY_KINDS = new Set(["death", "kicked", "disconnect"]);

/** lifecycle イベントとして書き込む種別（接続状態追跡用） */
const LIFECYCLE_KINDS = new Set(["spawn", "disconnect"]);

/** 同一種別の通知を連続送信しないための最小間隔（ms） */
const NOTIFY_COOLDOWN_MS = 30_000;

export interface AutoNotifier {
	(kind: string, description: string, importance: Importance): void;
}

/** BotContext.pushEvent から呼ばれる自動通知コールバックを生成する */
export function createAutoNotifier(db: StoreDb, metrics?: MetricsCollector): AutoNotifier {
	const lastNotified = new Map<string, number>();

	return (kind: string, description: string, _importance: Importance) => {
		// 接続状態を lifecycle イベントとして記録（Discord 側で接続状態を判定するため）
		if (LIFECYCLE_KINDS.has(kind)) {
			try {
				insertBridgeEvent(db, "to_discord", "lifecycle", kind);
			} catch (err) {
				console.error("[auto-notifier] lifecycle insert failed:", err);
			}
		}

		if (!AUTO_NOTIFY_KINDS.has(kind)) return;

		const now = Date.now();
		const last = lastNotified.get(kind) ?? 0;
		if (now - last < NOTIFY_COOLDOWN_MS) return;
		lastNotified.set(kind, now);

		const payload = JSON.stringify({ message: description, importance: "high", auto: true });
		try {
			insertBridgeEvent(db, "to_discord", "report", payload);
			metrics?.incrementCounter(METRIC.MC_AUTO_NOTIFICATIONS, { kind });
		} catch (err) {
			console.error("[auto-notifier] bridge insert failed:", err);
		}
	};
}
