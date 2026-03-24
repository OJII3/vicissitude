import { METRIC } from "./constants.ts";
import type { DueReminder, HeartbeatConfig, MetricsCollector, TokenUsage } from "./types.ts";

// ─── labelsToKey ─────────────────────────────────────────────────

/** Prometheus ラベルを `{k1="v1",k2="v2"}` 形式のキーに変換する */
export function labelsToKey(labels: Record<string, string>): string {
	const entries = Object.entries(labels).toSorted(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "";
	return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

/** Prometheus テキストフォーマット用のラベル値エスケープ */
function escapeLabel(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

// ─── Token Metrics Helper ───────────────────────────────────────

export function recordTokenMetrics(
	metrics: MetricsCollector,
	tokens: TokenUsage,
	labels: Record<string, string>,
): void {
	if (tokens.input > 0) metrics.addCounter(METRIC.LLM_INPUT_TOKENS, tokens.input, labels);
	if (tokens.output > 0) metrics.addCounter(METRIC.LLM_OUTPUT_TOKENS, tokens.output, labels);
	if (tokens.cacheRead > 0)
		metrics.addCounter(METRIC.LLM_CACHE_READ_TOKENS, tokens.cacheRead, labels);
}

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
				description: "最近の会話を振り返り、LTM に蓄積された行動ガイドラインを確認する",
				schedule: { type: "interval", minutes: 360 },
				lastExecutedAt: null,
				enabled: true,
			},
			// config.minecraft 未設定時でも含める（heartbeat-config.json に永続化されるため条件付き追加は不整合を招く）。
			// デフォルト無効。config.minecraft 設定時に有効化される想定。
			{
				id: "mc-check",
				description:
					"マイクラの様子を確認する。<minecraft-status> を見て、話したいことがあればホームチャンネルで話す",
				schedule: { type: "interval", minutes: 15 },
				lastExecutedAt: null,
				enabled: false,
			},
		],
	};
}

// ─── splitMessage ────────────────────────────────────────────────

const DEFAULT_MAX_LENGTH = 2000;

/**
 * メッセージを指定の文字数制限に合わせて分割する純粋関数。
 * 行の区切りで分割を試み、無理なら maxLength で切る。
 */
export function splitMessage(text: string, maxLength = DEFAULT_MAX_LENGTH): string[] {
	if (maxLength <= 0) throw new Error("maxLength must be positive");
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}
		const splitAt = remaining.lastIndexOf("\n", maxLength);
		if (splitAt <= 0) {
			chunks.push(remaining.slice(0, maxLength));
			remaining = remaining.slice(maxLength);
		} else {
			chunks.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt + 1);
		}
	}
	return chunks;
}

// ─── evaluateDueReminders ────────────────────────────────────────

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

// ─── formatTimestamp / formatTime ────────────────────────────────

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

export function formatTimestamp(date: Date): string {
	const jst = new Date(date.getTime() + JST_OFFSET_MS);
	const y = jst.getUTCFullYear();
	const mo = pad(jst.getUTCMonth() + 1);
	const d = pad(jst.getUTCDate());
	const h = pad(jst.getUTCHours());
	const mi = pad(jst.getUTCMinutes());
	return `${y}-${mo}-${d} ${h}:${mi}`;
}

export function formatTime(date: Date): string {
	const jst = new Date(date.getTime() + JST_OFFSET_MS);
	const h = pad(jst.getUTCHours());
	const mi = pad(jst.getUTCMinutes());
	return `${h}:${mi}`;
}

// ─── delayResolve ────────────────────────────────────────────────

/** 指定ミリ秒後に値を返す Promise を生成する */
export function delayResolve<T>(ms: number, value: T): Promise<T> {
	return new Promise((_resolve) => {
		setTimeout(() => _resolve(value), ms);
	});
}

// ─── withTimeout ─────────────────────────────────────────────────

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});

	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
