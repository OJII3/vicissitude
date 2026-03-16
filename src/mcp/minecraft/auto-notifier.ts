import { METRIC } from "@vicissitude/shared/constants";
import type { MetricsCollector } from "@vicissitude/shared/types";
import type { StoreDb } from "../../store/db.ts";
import { getSessionLockGuildId, setMcConnectionStatus } from "../../store/mc-bridge.ts";
import { appendEvent } from "../../store/queries.ts";
import type { Importance } from "./helpers.ts";

/** Discord 自動通知の対象イベント種別 */
const AUTO_NOTIFY_KINDS = new Set(["death", "kicked", "disconnect"]);

/** 接続状態を追跡するイベント種別 */
const CONNECT_KINDS = new Set(["spawn"]);
const DISCONNECT_KINDS = new Set(["disconnect"]);

/** 同一種別の通知を連続送信しないための最小間隔（ms） */
const NOTIFY_COOLDOWN_MS = 30_000;

export interface AutoNotifier {
	(kind: string, description: string, importance: Importance): void;
}

/** BotContext.pushEvent から呼ばれる自動通知コールバックを生成する */
export function createAutoNotifier(db: StoreDb, metrics?: MetricsCollector): AutoNotifier {
	const lastNotified = new Map<string, number>();

	return (kind: string, description: string, _importance: Importance) => {
		// 接続状態を mc_session_lock に記録
		if (CONNECT_KINDS.has(kind)) {
			try {
				setMcConnectionStatus(db, true);
			} catch (err) {
				console.error("[auto-notifier] connection status update failed:", err);
			}
		} else if (DISCONNECT_KINDS.has(kind)) {
			try {
				setMcConnectionStatus(db, false);
			} catch (err) {
				console.error("[auto-notifier] connection status update failed:", err);
			}
		}

		if (!AUTO_NOTIFY_KINDS.has(kind)) return;

		const now = Date.now();
		const last = lastNotified.get(kind) ?? 0;
		if (now - last < NOTIFY_COOLDOWN_MS) return;
		lastNotified.set(kind, now);

		// 対象 Discord エージェントの agentId を mc_session_lock から特定
		const guildId = getSessionLockGuildId(db);
		if (!guildId) return;

		const targetAgentId = `discord:${guildId}`;
		const event = {
			ts: new Date().toISOString(),
			content: description,
			authorId: "minecraft",
			authorName: "Minecraft Auto",
			messageId: `mc-auto-${Date.now()}`,
			metadata: { type: "mc_report", importance: "high", category: "danger", auto: true },
		};
		try {
			appendEvent(db, targetAgentId, JSON.stringify(event));
			metrics?.incrementCounter(METRIC.MC_AUTO_NOTIFICATIONS, { kind });
		} catch (err) {
			console.error("[auto-notifier] event buffer insert failed:", err);
		}
	};
}
