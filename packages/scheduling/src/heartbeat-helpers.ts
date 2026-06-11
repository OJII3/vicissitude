import { JST_OFFSET_MS } from "@vicissitude/shared/functions";
import type {
	DueReminder,
	HeartbeatConfig,
	HeartbeatReminder,
	ReminderSchedule,
} from "@vicissitude/shared/types";

/** Heartbeat config JSON の相対パス（プロジェクトルート起点） */
export const HEARTBEAT_CONFIG_RELATIVE_PATH = "data/heartbeat-config.json";

// ─── createDefaultHeartbeatConfig ────────────────────────────────

export function createDefaultHeartbeatConfig(): HeartbeatConfig {
	return {
		baseIntervalMinutes: 1,
		reminders: [
			{
				id: "home-check",
				description: "ホームチャンネルの様子を見る",
				schedule: { type: "interval", minutes: 1440 },
				lastExecutedAt: null,
				enabled: true,
			},
			{
				id: "memory-update",
				description: "最近の会話を振り返り、記憶に蓄積された行動ガイドラインを確認する",
				schedule: { type: "interval", minutes: 360 },
				lastExecutedAt: null,
				enabled: true,
			},
			{
				id: "character-reinforce",
				description: "直近の自分の応答を振り返り、キャラクター設定と記憶から自分らしさを再確認する",
				schedule: { type: "interval", minutes: 90 },
				lastExecutedAt: null,
				enabled: true,
			},
			// config.minecraft 未設定時でも含める（heartbeat-config.json に永続化されるため条件付き追加は不整合を招く）。
			// デフォルト無効。config.minecraft 設定時に有効化される想定。
			{
				id: "mc-check",
				description:
					"マイクラの様子を確認する。discord_minecraft_status ツールで確認し、話したいことがあればホームチャンネルで話す",
				schedule: { type: "interval", minutes: 15 },
				lastExecutedAt: null,
				enabled: false,
			},
			// config.emailCheck 未設定時でも含める（heartbeat-config.json に永続化されるため条件付き追加は不整合を招く）。
			// デフォルト無効。config.emailCheck 設定時に有効化される想定。
			{
				id: "email-check",
				description: "新着メールを確認する",
				schedule: { type: "interval", minutes: 5 },
				lastExecutedAt: null,
				enabled: false,
			},
		],
	};
}

// ─── evaluateDueReminders ────────────────────────────────────────

/**
 * 設定と現在時刻から、実行すべきリマインダーを判定する純粋関数。
 * daily スケジュールの時刻は JST として解釈される。
 */
export function evaluateDueReminders(config: HeartbeatConfig, now: Date): DueReminder[] {
	const results: DueReminder[] = [];

	for (const reminder of config.reminders) {
		if (!reminder.enabled) continue;

		const schedule = reminder.schedule;

		if (schedule.type === "interval") {
			const overdueMinutes = evaluateInterval(reminder.lastExecutedAt, schedule.minutes, now);
			if (overdueMinutes !== null) {
				results.push(createDueReminder(reminder, overdueMinutes));
			}
		} else if (schedule.type === "daily") {
			const overdueMinutes = evaluateDaily(
				reminder.lastExecutedAt,
				schedule.hour,
				schedule.minute,
				now,
			);
			if (overdueMinutes !== null) {
				results.push(createDueReminder(reminder, overdueMinutes));
			}
		}
	}

	return results;
}

function createDueReminder(reminder: HeartbeatReminder, overdueMinutes: number): DueReminder {
	const clonedReminder = cloneReminder(reminder);
	Object.freeze(clonedReminder.schedule);
	Object.freeze(clonedReminder);
	return Object.freeze({ reminder: clonedReminder, overdueMinutes }) as DueReminder;
}

function cloneReminder(reminder: HeartbeatReminder): HeartbeatReminder {
	return {
		id: reminder.id,
		description: reminder.description,
		schedule: cloneSchedule(reminder.schedule),
		lastExecutedAt: reminder.lastExecutedAt,
		enabled: reminder.enabled,
		...(reminder.scopeId === undefined ? {} : { scopeId: reminder.scopeId }),
	};
}

function cloneSchedule(schedule: ReminderSchedule): ReminderSchedule {
	if (schedule.type === "interval") {
		return { type: "interval", minutes: schedule.minutes };
	}
	return { type: "daily", hour: schedule.hour, minute: schedule.minute };
}

function evaluateInterval(
	lastExecutedAt: string | null,
	intervalMinutes: number,
	now: Date,
): number | null {
	if (lastExecutedAt === null) {
		return intervalMinutes;
	}

	const lastTime = new Date(lastExecutedAt).getTime();
	// treat invalid date as never executed
	if (Number.isNaN(lastTime)) {
		return intervalMinutes;
	}
	const elapsedMinutes = (now.getTime() - lastTime) / (1000 * 60);

	if (elapsedMinutes >= intervalMinutes) {
		return Math.floor(elapsedMinutes - intervalMinutes);
	}

	return null;
}

/**
 * daily スケジュールの判定。hour/minute は JST として解釈する。
 * ローカルタイムゾーンに依存しないよう、UTC メソッドで計算する。
 */
function evaluateDaily(
	lastExecutedAt: string | null,
	hour: number,
	minute: number,
	now: Date,
): number | null {
	// now を JST に変換（UTC メソッドで JST 値を取得できるようにシフト）
	const nowJstMs = now.getTime() + JST_OFFSET_MS;
	const nowJst = new Date(nowJstMs);

	// 今日の対象時刻を JST 空間で作成
	const todayTarget = new Date(nowJst);
	todayTarget.setUTCHours(hour, minute, 0, 0);

	if (nowJstMs < todayTarget.getTime()) {
		return null;
	}

	if (lastExecutedAt === null) {
		const overdueMinutes = (nowJstMs - todayTarget.getTime()) / (1000 * 60);
		return Math.floor(overdueMinutes);
	}

	// lastExecutedAt も JST 空間に変換して比較
	const lastRawMs = new Date(lastExecutedAt).getTime();
	if (Number.isNaN(lastRawMs)) {
		const overdueMinutes = (nowJstMs - todayTarget.getTime()) / (1000 * 60);
		return Math.floor(overdueMinutes);
	}
	const lastJstMs = lastRawMs + JST_OFFSET_MS;
	if (lastJstMs >= todayTarget.getTime()) {
		return null;
	}

	const overdueMinutes = (nowJstMs - todayTarget.getTime()) / (1000 * 60);
	return Math.floor(overdueMinutes);
}
