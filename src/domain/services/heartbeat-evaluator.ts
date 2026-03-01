import type { DueReminder, HeartbeatConfig } from "../entities/heartbeat-config.ts";

/**
 * 設定と現在時刻から、実行すべきリマインダーを判定する純粋関数。
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

function evaluateDaily(
	lastExecutedAt: string | null,
	hour: number,
	minute: number,
	now: Date,
): number | null {
	const todayTarget = new Date(now);
	todayTarget.setHours(hour, minute, 0, 0);

	if (now.getTime() < todayTarget.getTime()) {
		return null;
	}

	if (lastExecutedAt === null) {
		const overdueMinutes = (now.getTime() - todayTarget.getTime()) / (1000 * 60);
		return Math.floor(overdueMinutes);
	}

	const lastTime = new Date(lastExecutedAt);
	if (lastTime.getTime() >= todayTarget.getTime()) {
		return null;
	}

	const overdueMinutes = (now.getTime() - todayTarget.getTime()) / (1000 * 60);
	return Math.floor(overdueMinutes);
}
