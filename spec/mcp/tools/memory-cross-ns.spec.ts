/* oxlint-disable no-non-null-assertion -- test assertions after toBeDefined() checks */
/* oxlint-disable require-await -- モック関数は同期値を返すが、インターフェースが async を要求する */
import { describe, expect, test } from "bun:test";

import type { MemoryDeps, MemoryReadServices } from "@vicissitude/mcp/tools/memory";
import type { Episode } from "@vicissitude/memory/episode";
import {
	discordGuildNamespace,
	INTERNAL_NAMESPACE,
	namespaceKey,
} from "@vicissitude/memory/namespace";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";

import { captureMemoryToolHandlers, type ToolResult } from "./memory-test-helpers";

// ─── Test fixtures ───────────────────────────────────────────────

const NOW = new Date("2026-01-01T00:00:00Z");

function makeFact(overrides: Partial<SemanticFact> & { id: string; fact: string }): SemanticFact {
	return {
		userId: "test-user",
		category: "preference",
		keywords: [],
		sourceEpisodicIds: [],
		embedding: [],
		validAt: NOW,
		invalidAt: null,
		createdAt: NOW,
		...overrides,
	};
}

function makeEpisode(overrides: Partial<Episode> & { id: string; title: string }): Episode {
	return {
		userId: "test-user",
		summary: `Summary of ${overrides.title}`,
		messages: [],
		embedding: [],
		surprise: 0.5,
		stability: 1.0,
		difficulty: 0.3,
		startAt: NOW,
		endAt: NOW,
		createdAt: NOW,
		lastReviewedAt: null,
		consolidatedAt: null,
		...overrides,
	};
}

// ─── Guild namespace fixtures ────────────────────────────────────

const GUILD_NS = discordGuildNamespace("111222333");

const guildFact1 = makeFact({ id: "gf-1", fact: "ギルドのファクト1", category: "preference" });
const guildFact2 = makeFact({ id: "gf-2", fact: "ギルドのファクト2", category: "interest" });
const guildEpisode1 = makeEpisode({ id: "ge-1", title: "ギルドのエピソード1" });

// ─── Internal namespace fixtures ─────────────────────────────────

const internalFact1 = makeFact({
	id: "if-1",
	fact: "最近よく聴いている曲はAimer",
	category: "interest",
});
const internalFact2 = makeFact({
	id: "if-2",
	fact: "音楽の好みはJ-POP",
	category: "preference",
});
const internalEpisode1 = makeEpisode({ id: "ie-1", title: "音楽聴取ログ" });

// ─── Mock memory services factory ────────────────────────────────

function createMockServices(facts: SemanticFact[], episodes: Episode[]): MemoryReadServices {
	return {
		retrieval: {
			retrieve: async (_userId: string, _query: string) => ({
				episodes: episodes.map((ep) => ({
					episode: ep,
					score: 0.8,
					retrievability: 0.5,
				})),
				facts: facts.map((f) => ({ fact: f, score: 0.7 })),
			}),
			flushReviews: async () => {},
		},
		semantic: {
			getFacts: async () => facts,
			getFactsByCategory: async (_userId: string, category: string) =>
				facts.filter((f) => f.category === category),
			search: async () => facts,
			invalidate: async () => {},
		},
	} as unknown as MemoryReadServices;
}

function createEmptyMockServices(): MemoryReadServices {
	return createMockServices([], []);
}

function createDeps(servicesMap: Map<string, MemoryReadServices>): MemoryDeps {
	return {
		getOrCreateMemory: (ns) => {
			const key = namespaceKey(ns);
			const services = servicesMap.get(key);
			if (!services) {
				throw new Error(`Unexpected namespace: ${key}`);
			}
			return services;
		},
	};
}

// ─── Tests ───────────────────────────────────────────────────────

describe("memory_retrieve: cross-namespace 検索", () => {
	test("discord-guild バインド時に internal namespace のファクト/エピソードも結果に含まれる", async () => {
		const servicesMap = new Map<string, MemoryReadServices>([
			[namespaceKey(GUILD_NS), createMockServices([guildFact1, guildFact2], [guildEpisode1])],
			[namespaceKey(INTERNAL_NAMESPACE), createMockServices([internalFact1], [internalEpisode1])],
		]);

		const { handlers } = captureMemoryToolHandlers(createDeps(servicesMap), GUILD_NS);
		const handler = handlers.get("memory_retrieve")!;
		expect(handler).toBeDefined();

		const result: ToolResult = await handler({ query: "音楽" });

		expect(result.isError).toBeUndefined();
		const text = result.content[0]!.text;

		// ギルドの記憶が含まれる
		expect(text).toContain("ギルドのファクト1");
		expect(text).toContain("ギルドのエピソード1");

		// internal の記憶も含まれる
		expect(text).toContain("最近よく聴いている曲はAimer");
		expect(text).toContain("音楽聴取ログ");
	});

	test("boundNamespace が internal の場合、結果が重複しない（二重検索しない）", async () => {
		const servicesMap = new Map<string, MemoryReadServices>([
			[
				namespaceKey(INTERNAL_NAMESPACE),
				createMockServices([internalFact1, internalFact2], [internalEpisode1]),
			],
		]);

		const { handlers } = captureMemoryToolHandlers(createDeps(servicesMap), INTERNAL_NAMESPACE);
		const handler = handlers.get("memory_retrieve")!;
		expect(handler).toBeDefined();

		const result: ToolResult = await handler({ query: "音楽" });

		expect(result.isError).toBeUndefined();
		const text = result.content[0]!.text;

		// internal のファクトが含まれる
		expect(text).toContain("最近よく聴いている曲はAimer");

		// 重複していないことを確認（同じファクトが2回出現しない）
		const aimerOccurrences = text.split("最近よく聴いている曲はAimer").length - 1;
		expect(aimerOccurrences).toBe(1);

		// エピソードの title は1回だけ（summary にも title 文字列が含まれるため title 出現回数で判定）
		const episodeTitlePattern = /### 音楽聴取ログ/g;
		const episodeTitleMatches = text.match(episodeTitlePattern);
		expect(episodeTitleMatches?.length ?? 0).toBe(1);
	});

	test("internal namespace に記憶がない場合でもエラーにならない", async () => {
		const servicesMap = new Map<string, MemoryReadServices>([
			[namespaceKey(GUILD_NS), createMockServices([guildFact1], [guildEpisode1])],
			[namespaceKey(INTERNAL_NAMESPACE), createEmptyMockServices()],
		]);

		const { handlers } = captureMemoryToolHandlers(createDeps(servicesMap), GUILD_NS);
		const handler = handlers.get("memory_retrieve")!;
		expect(handler).toBeDefined();

		const result: ToolResult = await handler({ query: "何か" });

		expect(result.isError).toBeUndefined();
		const text = result.content[0]!.text;

		// ギルドの記憶は正常に返る
		expect(text).toContain("ギルドのファクト1");
		expect(text).toContain("ギルドのエピソード1");
	});
});

describe("memory_get_facts: cross-namespace 検索", () => {
	test("discord-guild バインド時に internal namespace のファクトも結果に含まれる", async () => {
		const servicesMap = new Map<string, MemoryReadServices>([
			[namespaceKey(GUILD_NS), createMockServices([guildFact1, guildFact2], [])],
			[namespaceKey(INTERNAL_NAMESPACE), createMockServices([internalFact1, internalFact2], [])],
		]);

		const { handlers } = captureMemoryToolHandlers(createDeps(servicesMap), GUILD_NS);
		const handler = handlers.get("memory_get_facts")!;
		expect(handler).toBeDefined();

		const result: ToolResult = await handler({});

		expect(result.isError).toBeUndefined();
		const text = result.content[0]!.text;

		// ギルドのファクトが含まれる
		expect(text).toContain("ギルドのファクト1");
		expect(text).toContain("ギルドのファクト2");

		// internal のファクトも含まれる
		expect(text).toContain("最近よく聴いている曲はAimer");
		expect(text).toContain("音楽の好みはJ-POP");
	});

	test("category フィルタが internal namespace のファクトにも適用される", async () => {
		const servicesMap = new Map<string, MemoryReadServices>([
			[namespaceKey(GUILD_NS), createMockServices([guildFact1, guildFact2], [])],
			[namespaceKey(INTERNAL_NAMESPACE), createMockServices([internalFact1, internalFact2], [])],
		]);

		const { handlers } = captureMemoryToolHandlers(createDeps(servicesMap), GUILD_NS);
		const handler = handlers.get("memory_get_facts")!;
		expect(handler).toBeDefined();

		// category: "interest" でフィルタ
		const result: ToolResult = await handler({ category: "interest" });

		expect(result.isError).toBeUndefined();
		const text = result.content[0]!.text;

		// interest カテゴリのファクトのみ（guildFact2, internalFact1）
		expect(text).toContain("ギルドのファクト2");
		expect(text).toContain("最近よく聴いている曲はAimer");

		// preference カテゴリのファクトは含まれない（guildFact1, internalFact2）
		expect(text).not.toContain("ギルドのファクト1");
		expect(text).not.toContain("音楽の好みはJ-POP");
	});

	test("boundNamespace が internal の場合、結果が重複しない", async () => {
		const servicesMap = new Map<string, MemoryReadServices>([
			[namespaceKey(INTERNAL_NAMESPACE), createMockServices([internalFact1, internalFact2], [])],
		]);

		const { handlers } = captureMemoryToolHandlers(createDeps(servicesMap), INTERNAL_NAMESPACE);
		const handler = handlers.get("memory_get_facts")!;
		expect(handler).toBeDefined();

		const result: ToolResult = await handler({});

		expect(result.isError).toBeUndefined();
		const text = result.content[0]!.text;

		// internal のファクトが含まれる
		expect(text).toContain("最近よく聴いている曲はAimer");
		expect(text).toContain("音楽の好みはJ-POP");

		// 重複していないことを確認（各ファクトが出力テキストに1回だけ出現する）
		const lines = text.split("\n").filter((l) => l.includes("最近よく聴いている曲はAimer"));
		expect(lines.length).toBe(1);

		const jpopLines = text.split("\n").filter((l) => l.includes("音楽の好みはJ-POP"));
		expect(jpopLines.length).toBe(1);
	});
});
