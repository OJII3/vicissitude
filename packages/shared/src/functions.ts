// ─── formatTimestamp / formatTime ────────────────────────────────

/** JST (UTC+9) のオフセット（ミリ秒） */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

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

// ─── withTimeout / raceAbort ─────────────────────────────────────
//
// タイムアウト系ヘルパーの使い分けポリシー:
// - `withTimeout`: setTimeout ベース。呼び出し先に AbortSignal を伝播する必要がない
//   ケース（内部処理のみで完結する操作）に使う。
// - `raceAbort`:   AbortSignal ベース。呼び出し先（SDK / fetch 等）に signal を
//   伝播してキャンセルさせたい、または外部から既存の signal で打ち切りたい
//   ケースに使う。`AbortSignal.timeout(ms)` と組み合わせれば時間打ち切りも可能。

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

/**
 * AbortSignal.reason を Error に正規化する。
 * `AbortSignal.timeout` 由来は `TimeoutError` (DOMException)、
 * `AbortController.abort()` は reason 自体（Error でなければ `AbortError` に正規化）。
 */
function abortReasonToError(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new DOMException("Aborted", "AbortError");
}

/**
 * Promise と AbortSignal を競合させ、signal が先に abort されたら reject する。
 * signal 側の打ち切りで即座にリジェクトさせるため、promise 実装が signal を
 * 尊重しない（= 永久 pending のまま）場合でも呼び出し元を解放できる。
 *
 * reject 値は `abortReasonToError` で正規化された Error。
 */
export async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		throw abortReasonToError(signal);
	}
	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortReasonToError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, abortPromise]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

// ─── escapeUserMessageTag ───────────────────────────────────────

/** ユーザーメッセージ内の &lt;user_message&gt; / &lt;/user_message&gt; タグをエスケープし、タグインジェクションを防ぐ */
export function escapeUserMessageTag(content: string): string {
	return content
		.replaceAll("<user_message>", "&lt;user_message&gt;")
		.replaceAll("</user_message>", "&lt;/user_message&gt;");
}
