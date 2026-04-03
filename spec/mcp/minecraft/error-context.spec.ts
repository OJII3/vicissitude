/**
 * error-context 仕様テスト
 *
 * アクション失敗時にエージェントへ返すコンテキスト文字列を生成する関数群。
 *
 * 対象関数:
 * - buildCollectBlockContext(bot, blockName): バイオーム・Y座標・周辺ブロック上位5件・鉱石ヒントを含む文字列
 * - buildCraftItemContext(bot, itemName): インベントリ内アイテム一覧を含む文字列
 * - buildSleepContext(bot): 周辺ブロックにベッド素材があるか情報を含む文字列
 * - buildGoToContext(bot, targetPos): 現在位置と目標との距離を含む文字列
 *
 * 各関数の戻り値は3行以内であること。
 *
 * 実装配置予定: packages/minecraft/src/error-context.ts
 * エクスポートパス: @vicissitude/minecraft/error-context
 */

import { describe, expect, mock, test } from "bun:test";

import type {
	buildCollectBlockContext,
	buildCraftItemContext,
	buildGoToContext,
	buildSleepContext,
} from "@vicissitude/minecraft/error-context";

// ---------------------------------------------------------------------------
// makeBot ヘルパー
// ---------------------------------------------------------------------------

type InventoryItem = { name: string; displayName: string; count: number };

interface MakeBotOptions {
	/** bot.entity.position */
	position?: { x: number; y: number; z: number };
	/** bot.world.getBiome() が返すバイオームID */
	biomeId?: number;
	/** bot.registry.biomes テーブル */
	biomes?: Record<number, { name: string }>;
	/** getNearbyBlockCounts のモック: ブロック名 → カウント */
	nearbyBlocks?: Map<string, number>;
	/** bot.inventory.items() が返すアイテム配列 */
	inventoryItems?: InventoryItem[];
}

function makeBot(options: MakeBotOptions = {}) {
	const pos = options.position ?? { x: 10, y: 64, z: -20 };
	const biomeId = options.biomeId ?? 1;
	const biomes = options.biomes ?? { 1: { name: "plains" } };
	const inventoryItems = options.inventoryItems ?? [];

	return {
		entity: { position: pos },
		registry: { biomes },
		world: {
			getBiome: mock(() => biomeId),
		},
		inventory: {
			items: mock(() => inventoryItems),
		},
		// blockAt は getNearbyBlockCounts の内部で使われるが、
		// error-context 関数のモジュールテストでは getNearbyBlockCounts ごとモックする想定。
		// ここでは念のため stub を用意しておく。
		blockAt: mock(() => null),
	} as never;
}

// ---------------------------------------------------------------------------
// 型定義（実装前の仕様として宣言）
// ---------------------------------------------------------------------------

type BuildCollectBlockContext = typeof buildCollectBlockContext;
type BuildCraftItemContext = typeof buildCraftItemContext;
type BuildSleepContext = typeof buildSleepContext;
type BuildGoToContext = typeof buildGoToContext;

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** 文字列の行数を返す（末尾の空行は除く） */
function lineCount(s: string): number {
	return s.trimEnd().split("\n").length;
}

// ---------------------------------------------------------------------------
// buildCollectBlockContext 仕様テスト
// ---------------------------------------------------------------------------

describe("buildCollectBlockContext", () => {
	async function getFn(): Promise<BuildCollectBlockContext> {
		const mod = await import("@vicissitude/minecraft/error-context");
		return (mod as { buildCollectBlockContext: BuildCollectBlockContext }).buildCollectBlockContext;
	}

	test("バイオーム名を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot({ biomeId: 1, biomes: { 1: { name: "plains" } } });
		const result = fn(bot, "oak_log");
		expect(result).toContain("plains");
	});

	test("Y座標を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot({ position: { x: 10, y: 64, z: -20 } });
		const result = fn(bot, "oak_log");
		expect(result).toContain("64");
	});

	test("周辺ブロック情報を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot();
		const result = fn(bot, "oak_log");
		// 付近のブロック情報が含まれる（ブロックがなければ「なし」などの代替テキスト可）
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("鉱石の場合は Y 座標ヒントを含むこと", async () => {
		const fn = await getFn();
		const bot = makeBot({ position: { x: 0, y: -50, z: 0 } });
		const result = fn(bot, "diamond_ore");
		// 鉱石ヒントに "Y" が含まれること
		expect(result).toMatch(/Y/i);
	});

	test("鉱石でないブロックの場合はヒントなしで返ること", async () => {
		const fn = await getFn();
		const bot = makeBot();
		// oak_log は鉱石でないため、ヒントなしでも正常に返ること
		const result = fn(bot, "oak_log");
		expect(typeof result).toBe("string");
	});

	test("戻り値が3行以内であること", async () => {
		const fn = await getFn();
		const bot = makeBot();
		const result = fn(bot, "diamond_ore");
		expect(lineCount(result)).toBeLessThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// buildCraftItemContext 仕様テスト
// ---------------------------------------------------------------------------

describe("buildCraftItemContext", () => {
	async function getFn(): Promise<BuildCraftItemContext> {
		const mod = await import("@vicissitude/minecraft/error-context");
		return (mod as { buildCraftItemContext: BuildCraftItemContext }).buildCraftItemContext;
	}

	test("インベントリ内アイテム一覧を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot({
			inventoryItems: [
				{ name: "oak_log", displayName: "Oak Log", count: 3 },
				{ name: "stick", displayName: "Stick", count: 10 },
			],
		});
		const result = fn(bot, "crafting_table");
		// インベントリアイテム名が含まれること
		expect(result).toMatch(/oak_log|Oak Log|stick|Stick/i);
	});

	test("インベントリが空の場合も文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot({ inventoryItems: [] });
		const result = fn(bot, "stone_pickaxe");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("戻り値が3行以内であること", async () => {
		const fn = await getFn();
		const bot = makeBot({
			inventoryItems: [
				{ name: "oak_log", displayName: "Oak Log", count: 3 },
				{ name: "stick", displayName: "Stick", count: 10 },
				{ name: "cobblestone", displayName: "Cobblestone", count: 32 },
			],
		});
		const result = fn(bot, "stone_pickaxe");
		expect(lineCount(result)).toBeLessThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// buildSleepContext 仕様テスト
// ---------------------------------------------------------------------------

describe("buildSleepContext", () => {
	async function getFn(): Promise<BuildSleepContext> {
		const mod = await import("@vicissitude/minecraft/error-context");
		return (mod as { buildSleepContext: BuildSleepContext }).buildSleepContext;
	}

	test("周辺ブロック情報を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot();
		const result = fn(bot);
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("周辺にベッド素材（wool など）がある場合にその情報を含むこと", async () => {
		const fn = await getFn();
		// blockAt が white_wool を返すモック
		const bot = {
			entity: { position: { x: 0, y: 64, z: 0 } },
			registry: { biomes: { 1: { name: "plains" } } },
			world: { getBiome: mock(() => 1) },
			inventory: { items: mock(() => []) },
			blockAt: mock(() => ({ name: "white_wool" })),
		} as never;
		const result = fn(bot);
		// ベッド素材（wool）の情報が含まれること
		expect(result).toMatch(/wool|羊毛|bed|ベッド/i);
	});

	test("戻り値が3行以内であること", async () => {
		const fn = await getFn();
		const bot = makeBot();
		const result = fn(bot);
		expect(lineCount(result)).toBeLessThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// buildGoToContext 仕様テスト
// ---------------------------------------------------------------------------

describe("buildGoToContext", () => {
	async function getFn(): Promise<BuildGoToContext> {
		const mod = await import("@vicissitude/minecraft/error-context");
		return (mod as { buildGoToContext: BuildGoToContext }).buildGoToContext;
	}

	test("現在位置を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot({ position: { x: 10, y: 64, z: -20 } });
		const targetPos = { x: 50, y: 64, z: 30 };
		const result = fn(bot, targetPos);
		// 現在位置の座標が含まれること
		expect(result).toMatch(/10|64|-20/);
	});

	test("目標との距離を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot({ position: { x: 0, y: 64, z: 0 } });
		const targetPos = { x: 100, y: 64, z: 0 };
		const result = fn(bot, targetPos);
		// 距離情報が含まれること（100 か "100m" など）
		expect(result).toMatch(/\d+/);
	});

	test("目標座標を含む文字列を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot({ position: { x: 0, y: 64, z: 0 } });
		const targetPos = { x: 42, y: 70, z: -15 };
		const result = fn(bot, targetPos);
		// 目標座標の数値が含まれること
		expect(result).toMatch(/42|70|-15/);
	});

	test("戻り値が3行以内であること", async () => {
		const fn = await getFn();
		const bot = makeBot({ position: { x: 0, y: 64, z: 0 } });
		const targetPos = { x: 100, y: 70, z: 200 };
		const result = fn(bot, targetPos);
		expect(lineCount(result)).toBeLessThanOrEqual(3);
	});
});
