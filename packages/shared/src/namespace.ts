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

import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { resolve } from "path";

/** Memory のパーティショニング単位 */
export type MemoryNamespace =
	| { readonly surface: "agent-scope"; readonly scopeId: string }
	| { readonly surface: "internal" };

/** internal namespace における subject（userId カラムの固定値） */
export const HUA_SELF_SUBJECT = "hua:self";

/** internal namespace のシングルトン */
export const INTERNAL_NAMESPACE: MemoryNamespace = { surface: "internal" };

export const AGENT_SCOPE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
export const DISCORD_GUILD_ID_RE = /^\d+$/;
export const DISCORD_USER_ID_RE = /^\d+$/;

/** Discord adapter 用の guild ID バリデーション。core schema では使わない。 */
export const GUILD_ID_RE = DISCORD_GUILD_ID_RE;

/** Minecraft エージェントの agentId。minecraft brain の単一ルーティングキー。 */
export const MINECRAFT_AGENT_ID = "minecraft:brain";

/** agent-scope namespace を生成する（scopeId のバリデーション付き） */
export function agentScopeNamespace(scopeId: string): MemoryNamespace {
	assertAgentScopeId(scopeId);
	return { surface: "agent-scope", scopeId };
}

/** Discord guild ID から canonical scopeId を生成する。 */
export function discordScopeId(guildId: string): string {
	if (!DISCORD_GUILD_ID_RE.test(guildId)) {
		throw new Error(`Invalid guildId: ${guildId}`);
	}
	return `discord:guild:${guildId}`;
}

/** Discord scopeId から guild ID を取り出す。Discord scope でなければ null。 */
export function discordGuildIdFromScopeId(scopeId: string): string | null {
	const match = scopeId.match(/^discord:guild:(\d+)$/);
	return match?.[1] ?? null;
}

/** Discord DM 相手の user ID から canonical scopeId を生成する。 */
export function discordDmScopeId(userId: string): string {
	if (!DISCORD_USER_ID_RE.test(userId)) {
		throw new Error(`Invalid Discord userId: ${userId}`);
	}
	return `discord:dm:${userId}`;
}

/** Discord DM scopeId から user ID を取り出す。DM scope でなければ null。 */
export function discordDmUserIdFromScopeId(scopeId: string): string | null {
	const match = scopeId.match(/^discord:dm:(\d+)$/);
	return match?.[1] ?? null;
}

function assertAgentScopeId(scopeId: string): void {
	if (!AGENT_SCOPE_ID_RE.test(scopeId)) {
		throw new Error(`Invalid scopeId: ${scopeId}`);
	}
}

function scopePathSegment(scopeId: string): string {
	assertAgentScopeId(scopeId);
	return encodeURIComponent(scopeId);
}

function scopeIdFromPathSegment(segment: string): string | null {
	try {
		const scopeId = decodeURIComponent(segment);
		return AGENT_SCOPE_ID_RE.test(scopeId) ? scopeId : null;
	} catch {
		return null;
	}
}

/** namespace に対応する DB 配置ディレクトリの絶対パスを返す（mkdirSync 用） */
export function resolveMemoryDbDir(dataDir: string, namespace: MemoryNamespace): string {
	switch (namespace.surface) {
		case "agent-scope":
			// oxlint-disable-next-line typescript/no-unsafe-return -- resolve() の戻り値は string だが oxlint が誤検知する
			return resolve(dataDir, "scopes", scopePathSegment(namespace.scopeId));
		case "internal":
			// oxlint-disable-next-line typescript/no-unsafe-return -- resolve() の戻り値は string だが oxlint が誤検知する
			return resolve(dataDir, "internal");
	}
}

/** namespace に対応する DB ファイルの絶対パスを返す */
export function resolveMemoryDbPath(dataDir: string, namespace: MemoryNamespace): string {
	// oxlint-disable-next-line typescript/no-unsafe-return -- resolve() の戻り値は string だが oxlint が誤検知する
	return resolve(resolveMemoryDbDir(dataDir, namespace), "memory.db");
}

/**
 * namespace を Map キー・ログ用の安定した文字列にシリアライズする。
 * 異なる namespace は必ず異なるキーになる（衝突なし）。
 */
export function namespaceKey(namespace: MemoryNamespace): string {
	switch (namespace.surface) {
		case "agent-scope":
			return `agent-scope:${namespace.scopeId}`;
		case "internal":
			return "internal";
	}
}

/**
 * heartbeat 実行の session-key プレフィックス。
 * heartbeat-service が `${HEARTBEAT_SESSION_PREFIX}${scopeKey}` で session-key を生成し、
 * observability が同じプレフィックスで scope を解析する。両者の単一ソース。
 */
export const HEARTBEAT_SESSION_PREFIX = "system:heartbeat:";

/**
 * heartbeat の scopeKey から session-key を生成する。
 * scopeKey は canonical scopeId（例 `discord:guild:111`）または
 * グローバル heartbeat の `_autonomous` を取り得るため、ここでは検証しない
 * （生成側 heartbeat-service の規約に委ねる）。
 */
export function heartbeatSessionKey(scopeKey: string): string {
	return `${HEARTBEAT_SESSION_PREFIX}${scopeKey}`;
}

/**
 * session-key が heartbeat のものなら、プレフィックスを除いた scopeKey を返す。
 * heartbeat session-key でなければ null。
 * 戻り値の scopeKey は scopeId とは限らない（`_autonomous` 等を含む生の残余文字列）。
 */
export function scopeKeyFromHeartbeatSessionKey(sessionKey: string): string | null {
	if (!sessionKey.startsWith(HEARTBEAT_SESSION_PREFIX)) return null;
	return sessionKey.slice(HEARTBEAT_SESSION_PREFIX.length);
}

/** Discord agentId のエージェント種別 */
export type DiscordAgentRole = "polling" | "heartbeat";

/** agentId のパース結果 */
export type ParsedAgentId =
	| { readonly platform: "discord"; readonly role: DiscordAgentRole; readonly scopeId: string }
	| { readonly platform: "web"; readonly scopeId: string }
	| { readonly platform: "internal" }
	| null;

/**
 * agentId を解析してプラットフォーム・ロール・scopeId を返す。
 * 未知のプレフィックス・null/undefined/空文字・不正形式は null を返す。
 */
export function parseAgentId(agentId: string | null | undefined): ParsedAgentId {
	if (!agentId) return null;
	if (/^internal(?::.+)?$/.test(agentId)) {
		return { platform: "internal" };
	}
	const dm = agentId.match(/^discord:dm:(\d+)$/);
	if (dm?.[1]) {
		return { platform: "discord", role: "polling", scopeId: discordDmScopeId(dm[1]) };
	}
	const m = agentId.match(/^discord:(?:(heartbeat):)?(.+)$/);
	if (m?.[2] && DISCORD_GUILD_ID_RE.test(m[2])) {
		const role = (m[1] ?? "polling") as DiscordAgentRole;
		return { platform: "discord", role, scopeId: discordScopeId(m[2]) };
	}
	if (/^web:.+$/.test(agentId) && AGENT_SCOPE_ID_RE.test(agentId)) {
		return { platform: "web", scopeId: agentId };
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
			return agentScopeNamespace(parsed.scopeId);
		case "web":
			return agentScopeNamespace(parsed.scopeId);
		case "internal":
			return INTERNAL_NAMESPACE;
	}
}

/**
 * namespace のデフォルト subject（userId カラム値）を返す。
 *   - agent-scope: scopeId
 *   - internal:    HUA_SELF_SUBJECT
 */
export function defaultSubject(namespace: MemoryNamespace): string {
	switch (namespace.surface) {
		case "agent-scope":
			return namespace.scopeId;
		case "internal":
			return HUA_SELF_SUBJECT;
	}
}

/**
 * 旧 `guilds/{guildId}/memory.db` を新しい `scopes/{discord scope}/memory.db` へ移す。
 * 互換読み込みは行わず、起動時に一度だけ呼び出す migration として使う。
 */
export function migrateLegacyGuildMemoryNamespaces(dataDir: string): void {
	const legacyRoot = resolve(dataDir, "guilds");
	let entries: string[];
	try {
		entries = readdirSync(legacyRoot);
	} catch {
		return;
	}

	for (const name of entries) {
		if (!DISCORD_GUILD_ID_RE.test(name)) continue;
		const legacyDir = resolve(legacyRoot, name);
		if (!existsSync(resolve(legacyDir, "memory.db"))) continue;

		const namespace = agentScopeNamespace(discordScopeId(name));
		const targetDir = resolveMemoryDbDir(dataDir, namespace);
		if (existsSync(targetDir)) {
			throw new Error(
				`Cannot migrate legacy memory namespace ${legacyDir}: target already exists: ${targetDir}`,
			);
		}

		mkdirSync(resolve(dataDir, "scopes"), { recursive: true });
		renameSync(legacyDir, targetDir);
	}
}

/**
 * ディスク上の既存 DB ファイルから namespace を発見する。
 * consolidation スケジューラが 30 分に 1 回呼ぶ想定なので同期 I/O で問題なし。
 */
export function discoverNamespacesFromDisk(dataDir: string): MemoryNamespace[] {
	const result: MemoryNamespace[] = [];

	// internal/memory.db
	if (existsSync(resolve(dataDir, "internal", "memory.db"))) {
		result.push(INTERNAL_NAMESPACE);
	}

	// scopes/{encodedScopeId}/memory.db
	const scopesDir = resolve(dataDir, "scopes");
	let entries: string[];
	try {
		entries = readdirSync(scopesDir);
	} catch {
		return result;
	}
	for (const name of entries) {
		const scopeId = scopeIdFromPathSegment(name);
		if (scopeId && existsSync(resolve(scopesDir, name, "memory.db"))) {
			result.push(agentScopeNamespace(scopeId));
		}
	}

	return result;
}
