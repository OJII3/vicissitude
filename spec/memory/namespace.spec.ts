/**
 * MemoryNamespace 仕様テスト
 *
 * 目的:
 *   memory パッケージの分離単位を Discord guild ではなく AgentScope として
 *   扱い、core/shared の公開面を platform 非依存に保つ。
 *
 * 公開 API（memory パッケージから export される想定）:
 *
 *   export type MemoryNamespace =
 *     | { readonly surface: "agent-scope"; readonly scopeId: string }
 *     | { readonly surface: "internal" };
 *
 *   export function agentScopeNamespace(scopeId: string): MemoryNamespace;
 *   export function discordScopeId(guildId: string): string;
 *   export function discordGuildIdFromScopeId(scopeId: string): string | null;
 *   export const INTERNAL_NAMESPACE: MemoryNamespace;
 *
 *   export function migrateLegacyGuildMemoryNamespaces(dataDir: string): void;
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import {
	agentScopeNamespace,
	discordGuildIdFromScopeId,
	discordScopeId,
	discoverNamespacesFromDisk,
	INTERNAL_NAMESPACE,
	HUA_SELF_SUBJECT,
	defaultSubject,
	migrateLegacyGuildMemoryNamespaces,
	resolveMemoryDbPath,
	resolveMemoryDbDir,
	namespaceKey,
	resolveNamespaceFromAgentId,
	type MemoryNamespace,
} from "@vicissitude/memory/namespace";

const DATA_DIR = "/data/memory";
const TEMP_DIR = `/tmp/vicissitude-namespace-spec-${process.pid}`;
const DISCORD_SCOPE = "discord:guild:123456789";
const DISCORD_SCOPE_SEGMENT = "discord%3Aguild%3A123456789";

afterEach(() => {
	if (existsSync(TEMP_DIR)) {
		rmSync(TEMP_DIR, { recursive: true, force: true });
	}
});

describe("MemoryNamespace: factory / constant", () => {
	it("agentScopeNamespace は scopeId を持つ agent-scope namespace を返す", () => {
		const ns = agentScopeNamespace(DISCORD_SCOPE);
		expect(ns).toEqual({ surface: "agent-scope", scopeId: DISCORD_SCOPE });
	});

	it("agentScopeNamespace は path segment として危険な scopeId を拒否する", () => {
		expect(() => agentScopeNamespace("../malicious")).toThrow(/scopeId/i);
		expect(() => agentScopeNamespace("")).toThrow(/scopeId/i);
		expect(() => agentScopeNamespace("has space")).toThrow(/scopeId/i);
	});

	it("discordScopeId は Discord guild ID を canonical scopeId に変換する", () => {
		expect(discordScopeId("123456789")).toBe(DISCORD_SCOPE);
	});

	it("discordScopeId は非数字の guildId を拒否する", () => {
		expect(() => discordScopeId("../malicious")).toThrow(/guildId/i);
		expect(() => discordScopeId("abc")).toThrow(/guildId/i);
		expect(() => discordScopeId("")).toThrow(/guildId/i);
	});

	it("discordGuildIdFromScopeId は Discord scopeId から guildId を取り出す", () => {
		expect(discordGuildIdFromScopeId(DISCORD_SCOPE)).toBe("123456789");
		expect(discordGuildIdFromScopeId("minecraft:world:overworld")).toBeNull();
	});

	it("INTERNAL_NAMESPACE は internal surface を持つ", () => {
		expect(INTERNAL_NAMESPACE).toEqual({ surface: "internal" });
	});

	it("HUA_SELF_SUBJECT は hua:self である", () => {
		expect(HUA_SELF_SUBJECT).toBe("hua:self");
	});
});

describe("resolveMemoryDbPath / resolveMemoryDbDir", () => {
	it("agent-scope namespace は scope ベースのパス規則にマップする", () => {
		const ns = agentScopeNamespace(DISCORD_SCOPE);
		expect(resolveMemoryDbPath(DATA_DIR, ns)).toBe(
			resolve(DATA_DIR, "scopes", DISCORD_SCOPE_SEGMENT, "memory.db"),
		);
		expect(resolveMemoryDbDir(DATA_DIR, ns)).toBe(
			resolve(DATA_DIR, "scopes", DISCORD_SCOPE_SEGMENT),
		);
	});

	it("internal namespace は {dataDir}/internal/memory.db にマップする", () => {
		expect(resolveMemoryDbPath(DATA_DIR, INTERNAL_NAMESPACE)).toBe(
			resolve(DATA_DIR, "internal", "memory.db"),
		);
		expect(resolveMemoryDbDir(DATA_DIR, INTERNAL_NAMESPACE)).toBe(resolve(DATA_DIR, "internal"));
	});

	it("相対 dataDir でも resolve される", () => {
		const ns = agentScopeNamespace("minecraft:world:overworld");
		const result = resolveMemoryDbPath("data/memory", ns);
		expect(result).toBe(
			resolve("data/memory", "scopes", "minecraft%3Aworld%3Aoverworld", "memory.db"),
		);
	});
});

describe("namespaceKey", () => {
	it("agent-scope namespace は 'agent-scope:{scopeId}' にシリアライズされる", () => {
		const ns = agentScopeNamespace(DISCORD_SCOPE);
		expect(namespaceKey(ns)).toBe(`agent-scope:${DISCORD_SCOPE}`);
	});

	it("internal namespace は 'internal' にシリアライズされる", () => {
		expect(namespaceKey(INTERNAL_NAMESPACE)).toBe("internal");
	});

	it("異なる scopeId の key は衝突しない", () => {
		const a = namespaceKey(agentScopeNamespace("discord:guild:111"));
		const b = namespaceKey(agentScopeNamespace("discord:guild:222"));
		expect(a).not.toBe(b);
	});

	it("internal key と agent-scope key は衝突しない", () => {
		const scoped = namespaceKey(agentScopeNamespace(DISCORD_SCOPE));
		const internal = namespaceKey(INTERNAL_NAMESPACE);
		expect(scoped).not.toBe(internal);
		expect(scoped.startsWith("internal")).toBe(false);
	});
});

describe("resolveNamespaceFromAgentId", () => {
	it("'discord:heartbeat:{guildId}' を agent-scope に解決する", () => {
		expect(resolveNamespaceFromAgentId("discord:heartbeat:123456789")).toEqual(
			agentScopeNamespace(DISCORD_SCOPE),
		);
	});

	it("'discord:{guildId}' を agent-scope に解決する", () => {
		expect(resolveNamespaceFromAgentId("discord:987654321")).toEqual(
			agentScopeNamespace("discord:guild:987654321"),
		);
	});

	it("未知の agent_id プレフィックスは null を返す", () => {
		expect(resolveNamespaceFromAgentId("web:user:abc")).toBeNull();
		expect(resolveNamespaceFromAgentId("minecraft:world1")).toBeNull();
		expect(resolveNamespaceFromAgentId("random-string")).toBeNull();
	});

	it("null / undefined / 空文字は null を返す", () => {
		const undef: string | undefined = undefined;
		expect(resolveNamespaceFromAgentId(null)).toBeNull();
		expect(resolveNamespaceFromAgentId(undef)).toBeNull();
		expect(resolveNamespaceFromAgentId("")).toBeNull();
	});

	it("guildId 部分が非数字の discord agent_id は null を返す（不正入力）", () => {
		expect(resolveNamespaceFromAgentId("discord:heartbeat:abc")).toBeNull();
		expect(resolveNamespaceFromAgentId("discord:../malicious")).toBeNull();
	});

	it("'discord:legacy:{guildId}'（廃止されたロール）は null を返す", () => {
		expect(resolveNamespaceFromAgentId("discord:legacy:123456789")).toBeNull();
	});

	it("'internal:maintenance' を INTERNAL_NAMESPACE に解決する", () => {
		expect(resolveNamespaceFromAgentId("internal:maintenance")).toEqual(INTERNAL_NAMESPACE);
	});

	it("'internal:any-suffix' を INTERNAL_NAMESPACE に解決する", () => {
		expect(resolveNamespaceFromAgentId("internal:any-suffix")).toEqual(INTERNAL_NAMESPACE);
	});

	it("'internal'（suffix なし）を INTERNAL_NAMESPACE に解決する", () => {
		expect(resolveNamespaceFromAgentId("internal")).toEqual(INTERNAL_NAMESPACE);
	});
});

describe("defaultSubject", () => {
	it("internal namespace では HUA_SELF_SUBJECT を返す", () => {
		expect(defaultSubject(INTERNAL_NAMESPACE)).toBe(HUA_SELF_SUBJECT);
	});

	it("agent-scope namespace では scopeId を返す", () => {
		const ns = agentScopeNamespace(DISCORD_SCOPE);
		expect(defaultSubject(ns)).toBe(DISCORD_SCOPE);
	});
});

describe("core-server adapter 契約（resolveNamespaceFromAgentId fallback）", () => {
	it("discord agent_id → boundNamespace と boundScopeId が設定される", () => {
		const ns = resolveNamespaceFromAgentId("discord:heartbeat:12345");
		expect(ns).not.toBeNull();

		const boundNamespace = ns ?? undefined;
		const boundScopeId = ns?.surface === "agent-scope" ? ns.scopeId : undefined;
		const boundGuildId = boundScopeId ? discordGuildIdFromScopeId(boundScopeId) : undefined;

		expect(boundNamespace).toEqual(agentScopeNamespace("discord:guild:12345"));
		expect(boundScopeId).toBe("discord:guild:12345");
		expect(boundGuildId).toBe("12345");
	});

	it("未知 agent_id → boundNamespace / boundScopeId ともに undefined", () => {
		const ns = resolveNamespaceFromAgentId("web:user:abc");
		const boundNamespace = ns ?? undefined;
		const boundScopeId = ns?.surface === "agent-scope" ? ns.scopeId : undefined;

		expect(boundNamespace).toBeUndefined();
		expect(boundScopeId).toBeUndefined();
	});

	it("internal agent_id → boundNamespace は INTERNAL_NAMESPACE, boundScopeId は undefined", () => {
		const ns = resolveNamespaceFromAgentId("internal:maintenance");
		expect(ns).not.toBeNull();
		const boundNamespace = ns ?? undefined;
		const boundScopeId = ns?.surface === "agent-scope" ? ns.scopeId : undefined;
		expect(boundNamespace).toEqual(INTERNAL_NAMESPACE);
		expect(boundScopeId).toBeUndefined();
	});
});

describe("recorder subject 導出契約（defaultSubject）", () => {
	it("agent-scope namespace → subject は scopeId", () => {
		expect(defaultSubject(agentScopeNamespace("discord:guild:12345"))).toBe("discord:guild:12345");
	});

	it("internal namespace → subject は HUA_SELF_SUBJECT", () => {
		expect(defaultSubject(INTERNAL_NAMESPACE)).toBe(HUA_SELF_SUBJECT);
		expect(HUA_SELF_SUBJECT).toBe("hua:self");
	});

	it("subject は validateUserId を通過する: 非空・≤256 chars", () => {
		expect(HUA_SELF_SUBJECT.length).toBeGreaterThan(0);
		expect(HUA_SELF_SUBJECT.length).toBeLessThanOrEqual(256);
		expect(DISCORD_SCOPE.length).toBeLessThanOrEqual(256);
	});
});

describe("migrateLegacyGuildMemoryNamespaces", () => {
	it("guilds/{numericId}/memory.db を scopes/{discord scope}/memory.db へ移す", () => {
		const legacyDir = resolve(TEMP_DIR, "guilds", "123456789");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(resolve(legacyDir, "memory.db"), "");

		migrateLegacyGuildMemoryNamespaces(TEMP_DIR);

		expect(existsSync(resolve(legacyDir, "memory.db"))).toBe(false);
		expect(existsSync(resolve(TEMP_DIR, "scopes", DISCORD_SCOPE_SEGMENT, "memory.db"))).toBe(true);
	});
});

describe("discoverNamespacesFromDisk", () => {
	it("空ディレクトリ → 空配列を返す", () => {
		mkdirSync(TEMP_DIR, { recursive: true });
		const result = discoverNamespacesFromDisk(TEMP_DIR);
		expect(result).toEqual([]);
	});

	it("scopes/{scopeId}/memory.db が存在 → agent-scope namespace を返す", () => {
		const scopeDir = resolve(TEMP_DIR, "scopes", DISCORD_SCOPE_SEGMENT);
		mkdirSync(scopeDir, { recursive: true });
		writeFileSync(resolve(scopeDir, "memory.db"), "");

		const result = discoverNamespacesFromDisk(TEMP_DIR);
		expect(result).toEqual([agentScopeNamespace(DISCORD_SCOPE)]);
	});

	it("internal/memory.db が存在 → internal namespace を返す", () => {
		const internalDir = resolve(TEMP_DIR, "internal");
		mkdirSync(internalDir, { recursive: true });
		writeFileSync(resolve(internalDir, "memory.db"), "");

		const result = discoverNamespacesFromDisk(TEMP_DIR);
		expect(result).toEqual([INTERNAL_NAMESPACE]);
	});

	it("不正な scopeId のディレクトリ名 → スキップする", () => {
		const badDir = resolve(TEMP_DIR, "scopes", "has%20space");
		mkdirSync(badDir, { recursive: true });
		writeFileSync(resolve(badDir, "memory.db"), "");

		const result = discoverNamespacesFromDisk(TEMP_DIR);
		expect(result).toEqual([]);
	});

	it("memory.db がないディレクトリ → スキップする", () => {
		const scopeDir = resolve(TEMP_DIR, "scopes", DISCORD_SCOPE_SEGMENT);
		mkdirSync(scopeDir, { recursive: true });

		const result = discoverNamespacesFromDisk(TEMP_DIR);
		expect(result).toEqual([]);
	});

	it("scopes + internal 両方存在 → 両方返す", () => {
		const scopeDir = resolve(TEMP_DIR, "scopes", DISCORD_SCOPE_SEGMENT);
		mkdirSync(scopeDir, { recursive: true });
		writeFileSync(resolve(scopeDir, "memory.db"), "");

		const internalDir = resolve(TEMP_DIR, "internal");
		mkdirSync(internalDir, { recursive: true });
		writeFileSync(resolve(internalDir, "memory.db"), "");

		const result = discoverNamespacesFromDisk(TEMP_DIR);
		expect(result).toHaveLength(2);
		expect(result.some((ns) => ns.surface === "agent-scope" && ns.scopeId === DISCORD_SCOPE)).toBe(
			true,
		);
		expect(result.some((ns) => ns.surface === "internal")).toBe(true);
	});
});

describe("MemoryNamespace: 型レベル契約", () => {
	it("discriminated union として surface で分岐できる", () => {
		const namespaces: MemoryNamespace[] = [agentScopeNamespace(DISCORD_SCOPE), INTERNAL_NAMESPACE];

		for (const ns of namespaces) {
			switch (ns.surface) {
				case "agent-scope":
					expect(typeof ns.scopeId).toBe("string");
					break;
				case "internal":
					expect(Object.keys(ns)).toEqual(["surface"]);
					break;
				default: {
					const _exhaustive: never = ns;
					throw new Error(`non-exhaustive: ${String(_exhaustive)}`);
				}
			}
		}
	});
});
