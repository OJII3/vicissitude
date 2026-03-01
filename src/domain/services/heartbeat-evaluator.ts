import type { DueReminder, HeartbeatConfig } from "../entities/heartbeat-config.ts";

/** JST (UTC+9) のオフセット（ミリ秒） */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

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
				results.push({ reminder, overdueMinutes });
			}
		} else if (schedule.type === "daily") {
			const overdueMinutes = evaluateDaily(
				reminder.lastExecutedAt,
				schedule.hour,
				schedule.minute,
				now,
			);
			if (overdueMinutes !== null) {
				results.push({ reminder, overdueMinutes });
			}
		}
	}

	return results;
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
	const lastJstMs = new Date(lastExecutedAt).getTime() + JST_OFFSET_MS;
	if (lastJstMs >= todayTarget.getTime()) {
		return null;
	}

	const overdueMinutes = (nowJstMs - todayTarget.getTime()) / (1000 * 60);
	return Math.floor(overdueMinutes);
}
