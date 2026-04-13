/** JST (UTC+9) のオフセット（ミリ秒） */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 睡眠時間帯: JST 2:00-7:00 */
const SLEEP_START = 2;
const SLEEP_END = 7;

function jstHour(now: Date): number {
	const jstMs = now.getTime() + JST_OFFSET_MS;
	return new Date(jstMs).getUTCHours();
}

/**
 * 現在時刻がリスニング活動時間内かどうかを返す。
 * 活動時間: JST 7:00-翌2:00（睡眠帯 2:00-7:00 以外）
 */
export function shouldStartListening(now: Date): boolean {
	const hour = jstHour(now);
	return hour < SLEEP_START || hour >= SLEEP_END;
}
