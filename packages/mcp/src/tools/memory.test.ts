/* oxlint-disable no-non-null-assertion -- test assertions */
import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	INTERNAL_NAMESPACE,
	discordGuildNamespace,
	type MemoryNamespace,
} from "@vicissitude/memory/namespace";
import type { RetrievalResult } from "@vicissitude/memory/retrieval";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import type { z } from "zod";

import { registerMemoryTools, type MemoryDeps, type MemoryReadServices } from "./memory.ts";

// --- Helpers ----------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}>;

interface ToolRegistration {
	name: string;
	schema: {
		description: string;
		inputSchema: Record<string, z.ZodType>;
	};
	handler: ToolHandler;
}

function captureTools(
	deps: MemoryDeps,
	boundNamespace?: MemoryNamespace,
): Map<string, ToolRegistration> {
	const tools = new Map<string, ToolRegistration>();
	const fakeServer = {
		registerTool(name: string, schema: ToolRegistration["schema"], handler: ToolHandler) {
			tools.set(name, { name, schema, handler });
		},
	} as unknown as McpServer;
	registerMemoryTools(fakeServer, deps, boundNamespace);
	return tools;
}

const EMPTY_RESULT: RetrievalResult = { episodes: [], facts: [] };

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
	return {
		id: overrides.id ?? "f-1",
		userId: overrides.userId ?? "user",
		category: overrides.category ?? "identity",
		fact: overrides.fact ?? "test fact",
		keywords: overrides.keywords ?? ["test"],
		sourceEpisodicIds: overrides.sourceEpisodicIds ?? [],
		embedding: overrides.embedding ?? [],
		validAt: overrides.validAt ?? new Date(),
		invalidAt: overrides.invalidAt ?? null,
		createdAt: overrides.createdAt ?? new Date(),
	};
}

function makeRetrievalResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
	return {
		episodes: overrides.episodes ?? [],
		facts: overrides.facts ?? [],
	};
}

function stubMemoryReadServices(
	overrides: Partial<{
		retrieve: MemoryReadServices["retrieval"]["retrieve"];
		getFacts: MemoryReadServices["semantic"]["getFacts"];
		getFactsByCategory: MemoryReadServices["semantic"]["getFactsByCategory"];
	}> = {},
): MemoryReadServices {
	return {
		retrieval: {
			retrieve: overrides.retrieve ?? (() => Promise.resolve(EMPTY_RESULT)),
		} as MemoryReadServices["retrieval"],
		semantic: {
			getFacts: overrides.getFacts ?? (() => Promise.resolve([])),
			getFactsByCategory: overrides.getFactsByCategory ?? (() => Promise.resolve([])),
		} as MemoryReadServices["semantic"],
	};
}

// --- shouldCrossSearch flag --------------------------------------------------

describe("shouldCrossSearch flag", () => {
	test("boundNamespace が discord-guild のとき internal も並行検索される", async () => {
		const calledNamespaces: MemoryNamespace[] = [];
		const guildNs = discordGuildNamespace("123456789");
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				calledNamespaces.push(ns);
				return stubMemoryReadServices();
			},
		};
		const tools = captureTools(deps, guildNs);
		await tools.get("memory_retrieve")!.handler({ query: "test" });

		expect(calledNamespaces).toHaveLength(2);
		expect(calledNamespaces[0]).toEqual(guildNs);
		expect(calledNamespaces[1]).toEqual(INTERNAL_NAMESPACE);
	});

	test("boundNamespace が internal のとき internal の並行検索は行わない", async () => {
		const calledNamespaces: MemoryNamespace[] = [];
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				calledNamespaces.push(ns);
				return stubMemoryReadServices();
			},
		};
		const tools = captureTools(deps, INTERNAL_NAMESPACE);
		await tools.get("memory_retrieve")!.handler({ query: "test" });

		expect(calledNamespaces).toHaveLength(1);
		expect(calledNamespaces[0]).toEqual(INTERNAL_NAMESPACE);
	});

	test("boundNamespace が undefined のとき guild_id 指定で internal も並行検索される", async () => {
		const calledNamespaces: MemoryNamespace[] = [];
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				calledNamespaces.push(ns);
				return stubMemoryReadServices();
			},
		};
		// boundNamespace = undefined (guild_id パラメータで動的解決)
		const tools = captureTools(deps);
		await tools.get("memory_retrieve")!.handler({ guild_id: "999888777", query: "test" });

		expect(calledNamespaces).toHaveLength(2);
		expect(calledNamespaces[0]).toEqual(discordGuildNamespace("999888777"));
		expect(calledNamespaces[1]).toEqual(INTERNAL_NAMESPACE);
	});
});

// --- memory_retrieve ---------------------------------------------------------

describe("memory_retrieve — cross-namespace 並行検索", () => {
	test("Promise.all で guild と internal の retrieve が並行実行される", async () => {
		const callOrder: string[] = [];
		const guildNs = discordGuildNamespace("111");
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				const label = ns.surface === "internal" ? "internal" : "guild";
				return stubMemoryReadServices({
					retrieve: () => {
						callOrder.push(`retrieve:${label}`);
						return Promise.resolve(EMPTY_RESULT);
					},
				});
			},
		};
		const tools = captureTools(deps, guildNs);
		await tools.get("memory_retrieve")!.handler({ query: "hello" });

		expect(callOrder).toContain("retrieve:guild");
		expect(callOrder).toContain("retrieve:internal");
	});

	test("internal の結果が「ふあ自身の記憶」セクションに分かれて表示される", async () => {
		const guildNs = discordGuildNamespace("111");
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				if (ns.surface === "internal") {
					return stubMemoryReadServices({
						retrieve: () =>
							Promise.resolve(
								makeRetrievalResult({
									episodes: [
										{
											episode: {
												id: "ep-internal",
												title: "ふあの記憶",
												summary: "内部記憶の要約",
											} as RetrievalResult["episodes"][number]["episode"],
											score: 0.9,
											retrievability: 0.5,
										},
									],
									facts: [
										{
											fact: makeFact({ category: "identity", fact: "ふあは AI" }),
											score: 0.8,
										},
									],
								}),
							),
					});
				}
				return stubMemoryReadServices({
					retrieve: () =>
						Promise.resolve(
							makeRetrievalResult({
								episodes: [
									{
										episode: {
											id: "ep-guild",
											title: "ギルドの記憶",
											summary: "ギルド記憶の要約",
										} as RetrievalResult["episodes"][number]["episode"],
										score: 0.95,
										retrievability: 0.6,
									},
								],
							}),
						),
				});
			},
		};

		const tools = captureTools(deps, guildNs);
		const result = await tools.get("memory_retrieve")!.handler({ query: "記憶" });
		const text = result.content[0]!.text;

		expect(text).toContain("## エピソード記憶");
		expect(text).toContain("ギルドの記憶");
		expect(text).toContain("## ふあ自身の記憶（エピソード）");
		expect(text).toContain("ふあの記憶");
		expect(text).toContain("## ふあ自身の記憶（ファクト）");
		expect(text).toContain("ふあは AI");
	});

	test("namespace 解決不能時に isError を返す", async () => {
		const deps: MemoryDeps = {
			getOrCreateMemory: () => stubMemoryReadServices(),
		};
		// boundNamespace = undefined, guild_id も未指定
		const tools = captureTools(deps);
		const result = await tools.get("memory_retrieve")!.handler({ query: "test" });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("namespace");
	});

	test("両方の結果が空の場合「関連する記憶は見つかりませんでした」が返る", async () => {
		const guildNs = discordGuildNamespace("111");
		const deps: MemoryDeps = {
			getOrCreateMemory: () => stubMemoryReadServices(),
		};
		const tools = captureTools(deps, guildNs);
		const result = await tools.get("memory_retrieve")!.handler({ query: "nothing" });

		expect(result.content[0]!.text).toContain("関連する記憶は見つかりませんでした");
	});
});

// --- memory_retrieve エラーハンドリング --------------------------------------

describe("memory_retrieve — エラーハンドリング", () => {
	test("getOrCreateMemory が internal namespace で例外を投げた場合 isError を返す", async () => {
		const guildNs = discordGuildNamespace("111");
		let callCount = 0;
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				callCount++;
				if (ns.surface === "internal") {
					throw new Error("internal memory init failed");
				}
				return stubMemoryReadServices();
			},
		};
		const tools = captureTools(deps, guildNs);
		const result = await tools.get("memory_retrieve")!.handler({ query: "test" });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("internal memory init failed");
		expect(callCount).toBe(2);
	});

	test("guild の retrieve が例外を投げた場合 isError を返す", async () => {
		const guildNs = discordGuildNamespace("111");
		const deps: MemoryDeps = {
			getOrCreateMemory: () =>
				stubMemoryReadServices({
					retrieve: () => Promise.reject(new Error("retrieve boom")),
				}),
		};
		const tools = captureTools(deps, guildNs);
		const result = await tools.get("memory_retrieve")!.handler({ query: "test" });

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("retrieve boom");
	});
});

// --- memory_get_facts --------------------------------------------------------

describe("memory_get_facts — cross-namespace マージ", () => {
	test("internal のファクトがマージされ合計件数が表示される", async () => {
		const guildNs = discordGuildNamespace("111");
		const guildFacts = [
			makeFact({ id: "f-guild-1", fact: "guild fact 1" }),
			makeFact({ id: "f-guild-2", fact: "guild fact 2" }),
		];
		const internalFacts = [makeFact({ id: "f-internal-1", fact: "internal fact 1" })];

		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				if (ns.surface === "internal") {
					return stubMemoryReadServices({
						getFacts: () => Promise.resolve(internalFacts),
					});
				}
				return stubMemoryReadServices({
					getFacts: () => Promise.resolve(guildFacts),
				});
			},
		};
		const tools = captureTools(deps, guildNs);
		const result = await tools.get("memory_get_facts")!.handler({});
		const text = result.content[0]!.text;

		expect(text).toContain("3 件のファクト");
		expect(text).toContain("guild fact 1");
		expect(text).toContain("guild fact 2");
		expect(text).toContain("internal fact 1");
	});

	test("category フィルタが両方の namespace に適用される", async () => {
		const guildNs = discordGuildNamespace("111");
		const calls: Array<{ ns: string; category: string }> = [];

		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				const label = ns.surface === "internal" ? "internal" : "guild";
				return stubMemoryReadServices({
					getFactsByCategory: (_subject, category) => {
						calls.push({ ns: label, category });
						return Promise.resolve([]);
					},
				});
			},
		};
		const tools = captureTools(deps, guildNs);
		await tools.get("memory_get_facts")!.handler({ category: "preference" });

		expect(calls).toHaveLength(2);
		expect(calls).toContainEqual({ ns: "guild", category: "preference" });
		expect(calls).toContainEqual({ ns: "internal", category: "preference" });
	});

	test("boundNamespace が internal のとき guild ファクトは取得しない", async () => {
		const calledNamespaces: MemoryNamespace[] = [];
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				calledNamespaces.push(ns);
				return stubMemoryReadServices({
					getFacts: () => Promise.resolve([makeFact()]),
				});
			},
		};
		const tools = captureTools(deps, INTERNAL_NAMESPACE);
		const result = await tools.get("memory_get_facts")!.handler({});

		expect(calledNamespaces).toHaveLength(1);
		expect(calledNamespaces[0]).toEqual(INTERNAL_NAMESPACE);
		expect(result.content[0]!.text).toContain("1 件のファクト");
	});

	test("boundNamespace が undefined のとき guild_id 指定で internal もマージされる", async () => {
		const calledNamespaces: MemoryNamespace[] = [];
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				calledNamespaces.push(ns);
				return stubMemoryReadServices({
					getFacts: () => Promise.resolve([makeFact({ id: `f-${ns.surface}` })]),
				});
			},
		};
		const tools = captureTools(deps);
		const result = await tools.get("memory_get_facts")!.handler({ guild_id: "555" });

		expect(calledNamespaces).toHaveLength(2);
		expect(result.content[0]!.text).toContain("2 件のファクト");
	});

	test("ファクトが 0 件のとき「ファクトはまだありません」が返る", async () => {
		const guildNs = discordGuildNamespace("111");
		const deps: MemoryDeps = {
			getOrCreateMemory: () => stubMemoryReadServices(),
		};
		const tools = captureTools(deps, guildNs);
		const result = await tools.get("memory_get_facts")!.handler({});

		expect(result.content[0]!.text).toContain("ファクトはまだありません");
	});

	test("namespace 解決不能時に isError を返す", async () => {
		const deps: MemoryDeps = {
			getOrCreateMemory: () => stubMemoryReadServices(),
		};
		const tools = captureTools(deps);
		const result = await tools.get("memory_get_facts")!.handler({});

		expect(result.isError).toBe(true);
	});
});

// --- memory_get_facts エラーハンドリング -------------------------------------

describe("memory_get_facts — エラーハンドリング", () => {
	test("getOrCreateMemory が internal で例外を投げた場合 isError を返す", async () => {
		const guildNs = discordGuildNamespace("111");
		const deps: MemoryDeps = {
			getOrCreateMemory: (ns) => {
				if (ns.surface === "internal") {
					throw new Error("internal init error");
				}
				return stubMemoryReadServices({
					getFacts: () => Promise.resolve([makeFact()]),
				});
			},
		};
		const tools = captureTools(deps, guildNs);
		const result = await tools.get("memory_get_facts")!.handler({});

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("internal init error");
	});
});
