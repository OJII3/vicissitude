/**
 * 環境クエリツール仕様テスト
 *
 * 対象ツール（いずれも同期）:
 * - nearby_blocks: 周辺ブロックの種類と数を返す（デフォルト: 16、最大: 32）
 * - craftable_items: 現在のインベントリでクラフト可能なアイテム一覧を返す
 * - get_biome: 現在のバイオーム名を返す
 */

import { describe, expect, mock, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// MockServer ヘルパー
// ---------------------------------------------------------------------------

// oxlint-disable-next-line no-explicit-any -- テスト用モックのため any を許容
type Handler = (...args: any[]) => unknown;

function makeMockServer() {
	const tools = new Map<string, { config: unknown; handler: Handler }>();
	return {
		server: {
			registerTool: (name: string, config: unknown, handler: Handler) => {
				tools.set(name, { config, handler });
			},
		} as never as McpServer,
		getTool: (name: string) => tools.get(name),
	};
}

// ---------------------------------------------------------------------------
// makeBot ヘルパー
// ---------------------------------------------------------------------------

function makeBot(options?: {
	blockAt?: (pos: { x: number; y: number; z: number }) => { name: string } | null;
	recipesFor?: (itemId: number) => unknown[];
	biomeId?: number;
	biomes?: Record<number, { name: string }>;
}) {
	return {
		entity: { position: { x: 0, y: 64, z: 0 } },
		registry: {
			blocksByName: { oak_log: { id: 17 }, stone: { id: 1 }, diamond_ore: { id: 56 } },
			itemsArray: [
				{ id: 280, name: "stick", displayName: "Stick" },
				{ id: 58, name: "crafting_table", displayName: "Crafting Table" },
			],
			biomes: options?.biomes ?? { 1: { name: "plains" } },
		},
		blockAt: mock(options?.blockAt ?? (() => null)),
		recipesFor: mock(
			options?.recipesFor ?? ((itemId: number) => (itemId === 280 ? [{ fake: true }] : [])),
		),
		world: {
			getBiome: mock(() => options?.biomeId ?? 1),
		},
	} as never;
}

// ---------------------------------------------------------------------------
// GetBot 型
// ---------------------------------------------------------------------------

type GetBot = () => ReturnType<typeof makeBot> | null;

type RegisterNearbyBlocks = (server: McpServer, getBot: GetBot) => void;
type RegisterCraftableItems = (server: McpServer, getBot: GetBot) => void;
type RegisterGetBiome = (server: McpServer, getBot: GetBot) => void;

function textOf(result: unknown): string {
	const r = result as { content: { text: string }[] };
	return r.content[0]?.text ?? "";
}

const nullBot: GetBot = () => null;

// ---------------------------------------------------------------------------
// nearby_blocks 仕様テスト
// ---------------------------------------------------------------------------

describe("nearby_blocks", () => {
	async function getRegisterFn(): Promise<RegisterNearbyBlocks> {
		const mod = await import("@vicissitude/minecraft/actions/queries");
		return (mod as { registerNearbyBlocks: RegisterNearbyBlocks }).registerNearbyBlocks;
	}

	test("ツールが存在すること", async () => {
		const registerNearbyBlocks = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const getBot: GetBot = () => makeBot();

		registerNearbyBlocks(server, getBot as never);

		const tool = getTool("nearby_blocks");
		expect(tool).toBeDefined();
	});

	test("ボット未接続時にエラーメッセージを返すこと", async () => {
		const registerNearbyBlocks = await getRegisterFn();
		const { server, getTool } = makeMockServer();

		registerNearbyBlocks(server, nullBot as never);

		const tool = getTool("nearby_blocks");
		expect(tool).toBeDefined();
		const result = tool?.handler({});
		expect(textOf(result)).toContain("未接続");
	});

	test("周辺ブロックの種類と数を返すこと（空気ブロックを除外）", async () => {
		const registerNearbyBlocks = await getRegisterFn();
		const { server, getTool } = makeMockServer();

		// blockAt が stone を返すモック（空気ではないブロック）
		const bot = makeBot({
			blockAt: () => ({ name: "stone" }),
		});
		const getBot: GetBot = () => bot;

		registerNearbyBlocks(server, getBot as never);

		const tool = getTool("nearby_blocks");
		expect(tool).toBeDefined();
		const result = tool?.handler({ maxDistance: 4 });
		const text = textOf(result);

		expect(text).toContain("stone");
		expect(text).not.toContain("air");
	});

	test("maxDistance パラメータが存在すること（デフォルト: 16、最大: 32）", async () => {
		const registerNearbyBlocks = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const getBot: GetBot = () => makeBot();

		registerNearbyBlocks(server, getBot as never);

		const tool = getTool("nearby_blocks");
		expect(tool).toBeDefined();
		const config = tool?.config as { inputSchema?: Record<string, unknown> };
		expect(config?.inputSchema).toHaveProperty("maxDistance");
	});
});

// ---------------------------------------------------------------------------
// craftable_items 仕様テスト
// ---------------------------------------------------------------------------

describe("craftable_items", () => {
	async function getRegisterFn(): Promise<RegisterCraftableItems> {
		const mod = await import("@vicissitude/minecraft/actions/queries");
		return (mod as { registerCraftableItems: RegisterCraftableItems }).registerCraftableItems;
	}

	test("ツールが存在すること", async () => {
		const registerCraftableItems = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const getBot: GetBot = () => makeBot();

		registerCraftableItems(server, getBot as never);

		const tool = getTool("craftable_items");
		expect(tool).toBeDefined();
	});

	test("ボット未接続時にエラーメッセージを返すこと", async () => {
		const registerCraftableItems = await getRegisterFn();
		const { server, getTool } = makeMockServer();

		registerCraftableItems(server, nullBot as never);

		const tool = getTool("craftable_items");
		expect(tool).toBeDefined();
		const result = tool?.handler({});
		expect(textOf(result)).toContain("未接続");
	});

	test("クラフト可能なアイテム一覧を返すこと", async () => {
		const registerCraftableItems = await getRegisterFn();
		const { server, getTool } = makeMockServer();

		const bot = makeBot({
			recipesFor: (itemId: number) => (itemId === 280 ? [{ fake: true }] : []),
		});
		const getBot: GetBot = () => bot;

		registerCraftableItems(server, getBot as never);

		const tool = getTool("craftable_items");
		expect(tool).toBeDefined();
		const result = tool?.handler({});
		const text = textOf(result);

		expect(text).toContain("Stick");
		expect(text).not.toContain("Crafting Table");
	});

	test("クラフト可能なアイテムがない場合にその旨を返すこと", async () => {
		const registerCraftableItems = await getRegisterFn();
		const { server, getTool } = makeMockServer();

		const bot = makeBot({ recipesFor: () => [] });
		const getBot: GetBot = () => bot;

		registerCraftableItems(server, getBot as never);

		const tool = getTool("craftable_items");
		expect(tool).toBeDefined();
		const result = tool?.handler({});
		const text = textOf(result);
		expect(text).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// get_biome 仕様テスト
// ---------------------------------------------------------------------------

describe("get_biome", () => {
	async function getRegisterFn(): Promise<RegisterGetBiome> {
		const mod = await import("@vicissitude/minecraft/actions/queries");
		return (mod as { registerGetBiome: RegisterGetBiome }).registerGetBiome;
	}

	test("ツールが存在すること", async () => {
		const registerGetBiome = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const getBot: GetBot = () => makeBot();

		registerGetBiome(server, getBot as never);

		const tool = getTool("get_biome");
		expect(tool).toBeDefined();
	});

	test("ボット未接続時にエラーメッセージを返すこと", async () => {
		const registerGetBiome = await getRegisterFn();
		const { server, getTool } = makeMockServer();

		registerGetBiome(server, nullBot as never);

		const tool = getTool("get_biome");
		expect(tool).toBeDefined();
		const result = tool?.handler({});
		expect(textOf(result)).toContain("未接続");
	});

	test("現在のバイオーム名を返すこと", async () => {
		const registerGetBiome = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const bot = makeBot({ biomeId: 1, biomes: { 1: { name: "plains" } } });
		const getBot: GetBot = () => bot;

		registerGetBiome(server, getBot as never);

		const tool = getTool("get_biome");
		expect(tool).toBeDefined();
		const result = tool?.handler({});
		const text = textOf(result);
		expect(text).toContain("plains");
	});

	test("別のバイオームでも正しく名前を返すこと", async () => {
		const registerGetBiome = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const bot = makeBot({ biomeId: 2, biomes: { 2: { name: "desert" } } });
		const getBot: GetBot = () => bot;

		registerGetBiome(server, getBot as never);

		const tool = getTool("get_biome");
		expect(tool).toBeDefined();
		const result = tool?.handler({});
		const text = textOf(result);
		expect(text).toContain("desert");
	});
});
