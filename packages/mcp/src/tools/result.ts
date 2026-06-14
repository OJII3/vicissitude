/**
 * MCP tool 結果シェイプの共通ヘルパ。
 *
 * 各 tool に散在していた `{ content: [{ type: "text" as const, text }] }` の手書きと、
 * `boundScopeId ?? inputScopeId` の解決ガードを単一ソース化する。
 */

/** MCP tool が返すテキスト結果のシェイプ */
export interface ToolTextResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/** 非エラーのテキスト結果を返す。 */
export function textContent(text: string): ToolTextResult {
	return { content: [{ type: "text", text }] };
}

/**
 * エラーのテキスト結果を返す。
 *
 * `isError` はデフォルトで付けない（`undefined`）。これは既存の各 tool のエラー結果が
 * 「isError あり」と「isError なし」で混在しており、置換時に挙動を完全保存するため。
 * MCP プロトコル上 `isError` はクライアント (LLM) に観測されるため、付与の有無は
 * 各呼び出し箇所が現状どおり明示的に選択する。
 *
 * @param text エラーメッセージ
 * @param isError true を渡した場合のみ結果に `isError: true` を付与する
 */
export function errorContent(text: string, isError?: boolean): ToolTextResult {
	return isError
		? { content: [{ type: "text", text }], isError: true }
		: { content: [{ type: "text", text }] };
}

/** `resolveBoundScope` の戻り値。`ok: true` なら解決済み値、`ok: false` なら早期 return 用のエラー結果。 */
export type ResolveBoundResult =
	| { ok: true; value: string }
	| { ok: false; result: ToolTextResult };

/**
 * `boundValue ?? inputValue` を解決し、いずれも無ければエラー結果を返す。
 *
 * 既存の scope/guild 解決ガード（`const x = boundScopeId ?? scope_id; if (!x) return <error>`）を集約する。
 * エラー結果は `errorContent` 経由で生成され、デフォルトでは `isError` を付けない（既存挙動を保存）。
 *
 * @param boundValue 束縛済みの値（boundScopeId / boundGuildId 等）
 * @param inputValue ツール入力から渡された値（scope_id / guild_id 等）
 * @param missingText どちらも無い場合のエラーメッセージ（例: `"Error: scope_id is required"`）
 * @param isError エラー結果に `isError: true` を付ける場合は true
 */
export function resolveBoundScope(
	boundValue: string | undefined,
	inputValue: string | undefined,
	missingText: string,
	isError?: boolean,
): ResolveBoundResult {
	const value = boundValue ?? inputValue;
	if (!value) {
		return { ok: false, result: errorContent(missingText, isError) };
	}
	return { ok: true, value };
}
