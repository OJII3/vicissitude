/**
 * MemoryNamespace — memory パッケージのパーティショニング単位を表す tagged union。
 *
 * Canonical definition lives here (in @vicissitude/shared) so that any package
 * that only depends on shared (application / scheduling / agent 等) can still
 * construct and manipulate namespaces. `@vicissitude/memory/namespace` re-exports
 * these identifiers unchanged.
 *
 * 詳細な仕様契約は spec/memory/namespace.spec.ts を参照。
 */

import { resolve } from "path";

/** Memory のパーティショニング単位 */
export type MemoryNamespace =
	| { readonly surface: "discord-guild"; readonly guildId: string }
	| { readonly surface: "internal" };

/** internal namespace における subject（userId カラムの固定値） */
export const HUA_SELF_SUBJECT = "hua:self";

/** internal namespace のシングルトン */
export const INTERNAL_NAMESPACE: MemoryNamespace = { surface: "internal" };

export const GUILD_ID_RE = /^\d+$/;

/** discord-guild namespace を生成する（guildId のバリデーション付き） */
export function discordGuildNamespace(guildId: string): MemoryNamespace {
	if (!GUILD_ID_RE.test(guildId)) {
		throw new Error(`Invalid guildId: ${guildId}`);
	}
	return { surface: "discord-guild", guildId };
}

/** namespace に対応する DB 配置ディレクトリの絶対パスを返す（mkdirSync 用） */
export function resolveMemoryDbDir(dataDir: string, namespace: MemoryNamespace): string {
	switch (namespace.surface) {
		case "discord-guild":
			return resolve(dataDir, "guilds", namespace.guildId);
		case "internal":
			return resolve(dataDir, "internal");
	}
}

/** namespace に対応する DB ファイルの絶対パスを返す */
export function resolveMemoryDbPath(dataDir: string, namespace: MemoryNamespace): string {
	return resolve(resolveMemoryDbDir(dataDir, namespace), "memory.db");
}

/**
 * namespace を Map キー・ログ用の安定した文字列にシリアライズする。
 * 異なる namespace は必ず異なるキーになる（衝突なし）。
 */
export function namespaceKey(namespace: MemoryNamespace): string {
	switch (namespace.surface) {
		case "discord-guild":
			return `discord-guild:${namespace.guildId}`;
		case "internal":
			return "internal";
	}
}

/**
 * agent_id から namespace を解決する。
 * 未知のプレフィックス・null/undefined/空文字・不正形式は null を返す
 * （呼び出し元で fallback する）。
 */
export function resolveNamespaceFromAgentId(
	agentId: string | null | undefined,
): MemoryNamespace | null {
	if (!agentId) return null;
	const m = agentId.match(/^discord:(?:heartbeat:)?(.+)$/);
	if (m?.[1] && GUILD_ID_RE.test(m[1])) {
		return { surface: "discord-guild", guildId: m[1] };
	}
	return null;
}

/**
 * namespace のデフォルト subject（userId カラム値）を返す。
 *   - discord-guild: guildId（既存互換）
 *   - internal:      HUA_SELF_SUBJECT
 */
export function defaultSubject(namespace: MemoryNamespace): string {
	switch (namespace.surface) {
		case "discord-guild":
			return namespace.guildId;
		case "internal":
			return HUA_SELF_SUBJECT;
	}
}
