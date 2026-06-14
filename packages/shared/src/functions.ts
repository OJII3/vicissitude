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

// ─── sleep ───────────────────────────────────────────────────────

/**
 * 指定ミリ秒だけ待機する Promise を返す。
 *
 * `signal` が渡され、かつ待機中に abort された場合は、`setTimeout` を待たず
 * 即座に **resolve** する（reject しない）。すでに abort 済みの signal を渡した
 * 場合も即座に resolve する。`signal` 省略時は単純な時間待機。
 *
 * abort を「エラー」として扱いたい（reject させたい）場合は `sleep` ではなく
 * `raceAbort` を使うこと。`sleep` は協調的キャンセル（早期復帰）のみを提供する。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				done();
			},
			{ once: true },
		);
	});
}

// ─── isRecord ────────────────────────────────────────────────────

/**
 * 値が「プレーンなレコード」(非 null のオブジェクトで配列でない) かを判定する型ガード。
 *
 * 配列は `false` を返す。任意キーへ安全にアクセスするための前提条件として使う。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * AbortSignal を理由つき Error に正規化する。
 *
 * `signal.reason` が Error（`AbortSignal.timeout` 由来の `TimeoutError` DOMException 等）
 * ならそれをそのまま返す。Error でなければ `AbortError`（name="AbortError" の DOMException）に
 * 正規化する。`signal` 引数を受け取り、内部で `.reason` を読む契約に統一する
 * （reason を直接受け取る私製版は廃止）。
 */
export function abortReasonToError(signal: AbortSignal): Error {
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

// ─── formatErrorMessage ─────────────────────────────────────────

/**
 * 任意の throw 値を、人間可読な 1 行メッセージへ正規化する。
 *
 * - `Error`: `error.message` を返す（`name` プレフィックスは付けない。
 *   会話 context やユーザー可視文言に `TypeError:` 等の技術的接頭辞を
 *   混入させないため）。
 * - `string`: そのまま返す。
 * - それ以外（オブジェクト・数値・null 等）: `JSON.stringify` で文字列化する。
 *   `JSON.stringify` が `undefined` を返す（`undefined` 値など）場合や
 *   循環参照で例外を投げる場合は `String(error)` にフォールバックする。
 *
 * ログ・内部メッセージ・添付説明文など、例外を文字列として埋め込む全ての
 * 箇所で使う単一の正準ヘルパー。
 */
export function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

// ─── escapeUserMessageTag ───────────────────────────────────────

/** ユーザーメッセージ内の `<user_message>` / `</user_message>` タグをエスケープし、タグインジェクションを防ぐ */
export function escapeUserMessageTag(content: string): string {
	return content
		.replaceAll("<user_message>", "&lt;user_message&gt;")
		.replaceAll("</user_message>", "&lt;/user_message&gt;");
}
