/** JST (UTC+9) のオフセット（ミリ秒） */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** jitter 幅（±0.1） */
const JITTER_AMPLITUDE = 0.1;

/**
 * JST hour (0-23) から基準確率を返す純粋関数。
 * 時間帯により聴く頻度を変える:
 * - 2-7 時: 睡眠中、聴かない
 * - 7-9 時: 朝、低頻度
 * - 9-18 時: 日中、中頻度
 * - 18-24 時: 夜、高頻度
 * - 0-2 時: 深夜、中〜高頻度
 */
export function hourBucketProbability(hour: number): number {
	if (hour >= 2 && hour < 7) return 0.0;
	if (hour >= 7 && hour < 9) return 0.15;
	if (hour >= 9 && hour < 18) return 0.35;
	if (hour >= 18 && hour < 24) return 0.6;
	// 0-2 時
	return 0.5;
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function jstHour(now: Date): number {
	const jstMs = now.getTime() + JST_OFFSET_MS;
	return new Date(jstMs).getUTCHours();
}

/**
 * 現在時刻と random 関数から、リスニング開始すべきか判定する純粋関数。
 * base=0 の時間帯は jitter を適用せず常に false。
 */
export function shouldStartListening(now: Date, random: () => number): boolean {
	const hour = jstHour(now);
	const base = hourBucketProbability(hour);
	if (base === 0) return false;

	const jitter = (random() * 2 - 1) * JITTER_AMPLITUDE;
	const pEffective = clamp(base + jitter, 0, 1);
	return random() < pEffective;
}
