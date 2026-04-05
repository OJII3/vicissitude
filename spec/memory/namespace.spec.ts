/**
 * MemoryNamespace 仕様テスト
 *
 * 目的:
 *   memory パッケージの「guild 単位パーティショニング」を MemoryNamespace 型に
 *   抽象化し、将来的な surface 拡張（discord-dm / web / minecraft 等）に
 *   耐える構造へ一般化する。
 *
 * 設計決定:
 *   1. MemoryNamespace は tagged union。最初は `discord-guild` と `internal` の
 *      2 バリアントのみをサポートする。
 *   2. Subject 軸（userId カラム）はスキーマ変更せず流用する。internal namespace
 *      では `HUA_SELF_SUBJECT` 定数（"hua:self"）を固定値として使う。
 *   3. 既存の `{MEMORY_DATA_DIR}/guilds/{guildId}/memory.db` ディレクトリ構造は
 *      維持する。データ移行は行わない。
 *   4. internal namespace の DB パスは `{MEMORY_DATA_DIR}/internal/memory.db`。
 *
 * 公開 API（memory パッケージから export される想定）:
 *
 *   export type MemoryNamespace =
 *     | { readonly surface: "discord-guild"; readonly guildId: string }
 *     | { readonly surface: "internal" };
 *
 *   export const HUA_SELF_SUBJECT = "hua:self";
 *
 *   // ファクトリ関数（バリデーション付き）
 *   export function discordGuildNamespace(guildId: string): MemoryNamespace;
 *   export const INTERNAL_NAMESPACE: MemoryNamespace;
 *
 *   // DB パス解決: dataDir + namespace → 絶対 DB ファイルパス
 *   export function resolveMemoryDbPath(
 *     dataDir: string,
 *     namespace: MemoryNamespace,
 *   ): string;
 *
 *   // DB が配置されるディレクトリ（mkdirSync 用）
 *   export function resolveMemoryDbDir(
 *     dataDir: string,
 *     namespace: MemoryNamespace,
 *   ): string;
 *
 *   // Map キー・ログ用の安定した文字列表現（衝突なし・往復可）
 *   export function namespaceKey(namespace: MemoryNamespace): string;
 *   export function parseNamespaceKey(key: string): MemoryNamespace | null;
 *
 *   // agent_id → namespace の解決
 *   //   "discord:heartbeat:{guildId}" → discord-guild
 *   //   "discord:{guildId}"           → discord-guild
 *   //   "internal:*" 等（未定義）     → null（呼び出し元で fallback）
 *   export function resolveNamespaceFromAgentId(
 *     agentId: string | null | undefined,
 *   ): MemoryNamespace | null;
 *
 *   // subject（userId カラム用）解決
 *   //   discord-guild namespace: 呼び出し元が与える（従来どおり guildId や
 *   //                             userId を渡す）
 *   //   internal namespace:      HUA_SELF_SUBJECT を常に返す
 *   export function defaultSubject(namespace: MemoryNamespace): string;
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "path";

import {
	discordGuildNamespace,
	INTERNAL_NAMESPACE,
	HUA_SELF_SUBJECT,
	defaultSubject,
	resolveMemoryDbPath,
	resolveMemoryDbDir,
	namespaceKey,
	parseNamespaceKey,
	resolveNamespaceFromAgentId,
	type MemoryNamespace,
} from "@vicissitude/memory/namespace";

const DATA_DIR = "/data/memory";

describe("MemoryNamespace: factory / constant", () => {
	it("discordGuildNamespace は guildId を持つ discord-guild namespace を返す", () => {
		const ns = discordGuildNamespace("123456789");
		expect(ns).toEqual({ surface: "discord-guild", guildId: "123456789" });
	});

	it("discordGuildNamespace は非数字の guildId を拒否する", () => {
		expect(() => discordGuildNamespace("../malicious")).toThrow(/guildId/i);
		expect(() => discordGuildNamespace("abc")).toThrow(/guildId/i);
		expect(() => discordGuildNamespace("")).toThrow(/guildId/i);
	});

	it("INTERNAL_NAMESPACE は internal surface を持つ", () => {
		expect(INTERNAL_NAMESPACE).toEqual({ surface: "internal" });
	});

	it("HUA_SELF_SUBJECT は hua:self である", () => {
		expect(HUA_SELF_SUBJECT).toBe("hua:self");
	});
});

describe("resolveMemoryDbPath / resolveMemoryDbDir", () => {
	it("discord-guild namespace は既存のパス規則にマップする", () => {
		const ns = discordGuildNamespace("123456789");
		expect(resolveMemoryDbPath(DATA_DIR, ns)).toBe(
			resolve(DATA_DIR, "guilds", "123456789", "memory.db"),
		);
		expect(resolveMemoryDbDir(DATA_DIR, ns)).toBe(resolve(DATA_DIR, "guilds", "123456789"));
	});

	it("internal namespace は {dataDir}/internal/memory.db にマップする", () => {
		expect(resolveMemoryDbPath(DATA_DIR, INTERNAL_NAMESPACE)).toBe(
			resolve(DATA_DIR, "internal", "memory.db"),
		);
		expect(resolveMemoryDbDir(DATA_DIR, INTERNAL_NAMESPACE)).toBe(resolve(DATA_DIR, "internal"));
	});

	it("相対 dataDir でも resolve される", () => {
		const ns = discordGuildNamespace("123");
		const result = resolveMemoryDbPath("data/memory", ns);
		expect(result).toBe(resolve("data/memory", "guilds", "123", "memory.db"));
	});
});

describe("namespaceKey / parseNamespaceKey", () => {
	it("discord-guild namespace は 'discord-guild:{guildId}' にシリアライズされる", () => {
		const ns = discordGuildNamespace("123456789");
		expect(namespaceKey(ns)).toBe("discord-guild:123456789");
	});

	it("internal namespace は 'internal' にシリアライズされる", () => {
		expect(namespaceKey(INTERNAL_NAMESPACE)).toBe("internal");
	});

	it("discord-guild は往復できる", () => {
		const ns = discordGuildNamespace("987654321");
		const parsed = parseNamespaceKey(namespaceKey(ns));
		expect(parsed).toEqual(ns);
	});

	it("internal は往復できる", () => {
		const parsed = parseNamespaceKey(namespaceKey(INTERNAL_NAMESPACE));
		expect(parsed).toEqual(INTERNAL_NAMESPACE);
	});

	it("未知の key 形式は null を返す", () => {
		expect(parseNamespaceKey("unknown")).toBeNull();
		expect(parseNamespaceKey("discord-guild:")).toBeNull();
		expect(parseNamespaceKey("discord-guild:abc")).toBeNull();
		expect(parseNamespaceKey("")).toBeNull();
		expect(parseNamespaceKey("internal:extra")).toBeNull();
	});

	it("異なる guildId の discord-guild key は衝突しない", () => {
		const a = namespaceKey(discordGuildNamespace("111"));
		const b = namespaceKey(discordGuildNamespace("222"));
		expect(a).not.toBe(b);
	});

	it("internal key と discord-guild key は衝突しない", () => {
		const discord = namespaceKey(discordGuildNamespace("123"));
		const internal = namespaceKey(INTERNAL_NAMESPACE);
		expect(discord).not.toBe(internal);
		// internal prefix が数値 guildId と衝突しないこと
		expect(discord.startsWith("internal")).toBe(false);
	});
});

describe("resolveNamespaceFromAgentId", () => {
	it("'discord:heartbeat:{guildId}' を discord-guild に解決する", () => {
		expect(resolveNamespaceFromAgentId("discord:heartbeat:123456789")).toEqual(
			discordGuildNamespace("123456789"),
		);
	});

	it("'discord:{guildId}' を discord-guild に解決する", () => {
		expect(resolveNamespaceFromAgentId("discord:987654321")).toEqual(
			discordGuildNamespace("987654321"),
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
});

describe("defaultSubject", () => {
	it("internal namespace では HUA_SELF_SUBJECT を返す", () => {
		expect(defaultSubject(INTERNAL_NAMESPACE)).toBe(HUA_SELF_SUBJECT);
	});

	it("discord-guild namespace では guildId を返す（既存互換）", () => {
		// 既存コードは userId カラムに guildId を入れているため、
		// 互換性のため discord-guild の default subject は guildId とする。
		const ns = discordGuildNamespace("123456789");
		expect(defaultSubject(ns)).toBe("123456789");
	});
});

describe("core-server adapter 契約（resolveNamespaceFromAgentId fallback）", () => {
	// これらは namespace primitives の契約テスト。
	// core-server は agentId → namespace 解決後、以下の分岐で tool にパラメータを渡す:
	//   - Memory 系ツール:    boundNamespace = ns ?? undefined
	//   - Discord 固有ツール: boundGuildId   = ns?.surface === "discord-guild"
	//                                          ? ns.guildId : undefined

	it("discord agent_id → boundNamespace と boundGuildId が両方設定される", () => {
		const ns = resolveNamespaceFromAgentId("discord:heartbeat:12345");
		expect(ns).not.toBeNull();

		const boundNamespace = ns ?? undefined;
		const boundGuildId = ns?.surface === "discord-guild" ? ns.guildId : undefined;

		expect(boundNamespace).toEqual(discordGuildNamespace("12345"));
		expect(boundGuildId).toBe("12345");
	});

	it("未知 agent_id → boundNamespace / boundGuildId ともに undefined", () => {
		const ns = resolveNamespaceFromAgentId("web:user:abc");
		const boundNamespace = ns ?? undefined;
		const boundGuildId = ns?.surface === "discord-guild" ? ns.guildId : undefined;

		expect(boundNamespace).toBeUndefined();
		expect(boundGuildId).toBeUndefined();
	});

	it("agentId が null/undefined → boundNamespace / boundGuildId ともに undefined", () => {
		for (const input of [null, undefined]) {
			const ns = resolveNamespaceFromAgentId(input);
			const boundNamespace = ns ?? undefined;
			const boundGuildId = ns?.surface === "discord-guild" ? ns.guildId : undefined;

			expect(boundNamespace).toBeUndefined();
			expect(boundGuildId).toBeUndefined();
		}
	});

	it("将来の internal agent_id（仮）→ boundNamespace は設定、boundGuildId は undefined", () => {
		// 現状 resolveNamespaceFromAgentId は internal を解決しないため、
		// この契約は INTERNAL_NAMESPACE を直接与えた場合の挙動を検証する。
		const ns: MemoryNamespace = INTERNAL_NAMESPACE;
		const boundNamespace = ns;
		const boundGuildId = ns.surface === "discord-guild" ? ns.guildId : undefined;

		expect(boundNamespace).toEqual(INTERNAL_NAMESPACE);
		expect(boundGuildId).toBeUndefined();
	});
});

describe("recorder subject 導出契約（defaultSubject）", () => {
	// MemoryConversationRecorder は record(namespace, message) 時に
	// segmenter.addMessage(subject, msg) を呼ぶ。subject は
	// defaultSubject(namespace) で自動導出される。

	it("discord-guild namespace → subject は guildId（既存互換）", () => {
		expect(defaultSubject(discordGuildNamespace("12345"))).toBe("12345");
	});

	it("internal namespace → subject は HUA_SELF_SUBJECT", () => {
		expect(defaultSubject(INTERNAL_NAMESPACE)).toBe(HUA_SELF_SUBJECT);
		expect(HUA_SELF_SUBJECT).toBe("hua:self");
	});

	it("subject は validateUserId を通過する: 非空・≤256 chars", () => {
		// HUA_SELF_SUBJECT は validateUserId の制約を満たす
		expect(HUA_SELF_SUBJECT.length).toBeGreaterThan(0);
		expect(HUA_SELF_SUBJECT.length).toBeLessThanOrEqual(256);
	});
});

describe("MemoryNamespace: 型レベル契約", () => {
	it("discriminated union として surface で分岐できる", () => {
		const namespaces: MemoryNamespace[] = [discordGuildNamespace("123"), INTERNAL_NAMESPACE];

		for (const ns of namespaces) {
			switch (ns.surface) {
				case "discord-guild":
					expect(typeof ns.guildId).toBe("string");
					break;
				case "internal":
					// no additional fields
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
