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
	let dir: string;
	switch (namespace.surface) {
		case "discord-guild":
			dir = resolve(dataDir, "guilds", namespace.guildId);
			break;
		case "internal":
			dir = resolve(dataDir, "internal");
			break;
	}
	return dir;
}

/** namespace に対応する DB ファイルの絶対パスを返す */
export function resolveMemoryDbPath(dataDir: string, namespace: MemoryNamespace): string {
	const dir: string = resolveMemoryDbDir(dataDir, namespace);
	const dbPath: string = resolve(dir, "memory.db");
	return dbPath;
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

/** Discord agentId のエージェント種別 */
export type DiscordAgentRole = "polling" | "heartbeat";

/** agentId のパース結果 */
export type ParsedAgentId =
	| { readonly platform: "discord"; readonly role: DiscordAgentRole; readonly guildId: string }
	| { readonly platform: "internal" }
	| null;

/**
 * agentId を解析してプラットフォーム・ロール・guildId を返す。
 * 未知のプレフィックス・null/undefined/空文字・不正形式は null を返す。
 */
export function parseAgentId(agentId: string | null | undefined): ParsedAgentId {
	if (!agentId) return null;
	if (/^internal(?::.+)?$/.test(agentId)) {
		return { platform: "internal" };
	}
	const m = agentId.match(/^discord:(?:(heartbeat):)?(.+)$/);
	if (m?.[2] && GUILD_ID_RE.test(m[2])) {
		const role = (m[1] ?? "polling") as DiscordAgentRole;
		return { platform: "discord", role, guildId: m[2] };
	}
	return null;
}

/**
 * agent_id から namespace を解決する。
 * 未知のプレフィックス・null/undefined/空文字・不正形式は null を返す
 * （呼び出し元で fallback する）。
 */
export function resolveNamespaceFromAgentId(
	agentId: string | null | undefined,
): MemoryNamespace | null {
	const parsed = parseAgentId(agentId);
	if (!parsed) return null;
	switch (parsed.platform) {
		case "discord":
			return { surface: "discord-guild", guildId: parsed.guildId };
		case "internal":
			return INTERNAL_NAMESPACE;
	}
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
