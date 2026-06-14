// ─── FetchLike ───────────────────────────────────────────────────
//
// `typeof fetch` には Bun/Node 固有の `preconnect` 等が含まれ、テスト用スタブの
// 型付けが煩雑になる。本ヘルパーが実際に呼び出す形（URL と signal だけを渡す）に
// 限定した最小インターフェースを公開する。
//
// init を `{ signal?: AbortSignal }` に絞っているが、引数反変により
// `(url, init?: RequestInit) => Promise<Response>` 形の fetch 実装や
// グローバルの `fetch` もそのまま代入できる（より広い init を受ける関数は、
// より狭い init を要求する関数型へ代入可能）。

/**
 * タイムアウト付き fetch ヘルパーが要求する最小の fetch インターフェース。
 *
 * グローバル `fetch`・`(url, init?: RequestInit) => Promise<Response>` 形の
 * 実装・テスト用スタブのいずれも代入できる。
 */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

// ─── fetchWithTimeout ────────────────────────────────────────────

/**
 * `timeoutMs` を経過したら abort される `AbortSignal` を付けて `fetchFn` を呼ぶ。
 *
 * タイムアウト発火時は `fetchFn` に渡した signal が abort され、その実装次第で
 * 通常は `Promise` が reject される（グローバル `fetch` は `TimeoutError` で
 * reject する）。本関数自身は例外を握り潰さず、`fetchFn` の reject を
 * そのまま伝播する。タイムアウトを「null フォールバック」したい場合は呼び出し側で
 * try/catch するか、{@link fetchJsonWithTimeout} を使う。
 *
 * `clearTimeout` 相当の後始末は `AbortSignal.timeout` 側で管理されるため不要。
 */
export function fetchWithTimeout(
	fetchFn: FetchLike,
	url: string,
	timeoutMs: number,
): Promise<Response> {
	return fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
}

// ─── fetchJsonWithTimeout ────────────────────────────────────────

/**
 * `safeParse` だけを要求する構造的バリデータインターフェース。
 *
 * zod の `ZodType`（v3 / v4.3 / v4.4 ...）は構造的にこれを満たすため、
 * 本モジュールは zod へ依存せず任意の zod バージョン・自前バリデータを受け取れる。
 * zod を直接型引数に取ると、重複インストール（複数 minor 共存）時に branded な
 * internal 版数型が結合して TS2345 を招くため、それを避ける狙いがある。
 */
export interface SafeParseable<T> {
	safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/**
 * {@link fetchWithTimeout} で JSON を取得し `schema.safeParse` で検証する。
 *
 * 以下のいずれの場合も例外を投げず `null` を返す（フォールバック前提の API 用）:
 * - `res.ok` が false（HTTP 4xx/5xx）
 * - `res.json()` が失敗（不正な JSON）
 * - `schema.safeParse` が失敗（想定外のレスポンス形状）
 * - `fetchFn` がタイムアウト等で reject
 *
 * 成功時は parse 済みデータ（`T`）を返す。
 */
export async function fetchJsonWithTimeout<T>(
	fetchFn: FetchLike,
	url: string,
	schema: SafeParseable<T>,
	timeoutMs: number,
): Promise<T | null> {
	try {
		const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
		if (!res.ok) return null;
		const json = await res.json();
		const parsed = schema.safeParse(json);
		if (!parsed.success) return null;
		return parsed.data;
	} catch {
		return null;
	}
}
