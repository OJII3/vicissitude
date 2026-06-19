/**
 * bot-queries 仕様テスト
 *
 * 対象関数:
 * - getNearbyBlockCounts: 周辺ブロックの種類と数を Map<string, number> で返す
 *   - air 系ブロック（air, cave_air, void_air）を除外する
 *   - 結果をカウント降順でソートして返す
 */

import { describe, expect, mock, test } from "bun:test";

import type { getNearbyBlockCounts } from "@vicissitude/minecraft/bot-queries";

// ---------------------------------------------------------------------------
// makeBot ヘルパー
// ---------------------------------------------------------------------------

type BlockName = string;

/**
 * blockAt が返すブロックのシーケンスを指定して Bot モックを作る。
 * radius 内のすべてのブロック位置を走査するため、
 * 呼ばれるたびに blocks 配列を順番に返す。
 */
function makeBot(blocks: (BlockName | null)[]) {
	let callIndex = 0;
	return {
		entity: { position: { x: 0, y: 64, z: 0 } },
		blockAt: mock((_pos: unknown) => {
			const name = blocks[callIndex++ % blocks.length];
			if (name === null) return null;
			return { name };
		}),
	} as never;
}

// ---------------------------------------------------------------------------
// getNearbyBlockCounts 仕様テスト
// ---------------------------------------------------------------------------

describe("getNearbyBlockCounts", () => {
	async function getFn(): Promise<typeof getNearbyBlockCounts> {
		const mod = await import("@vicissitude/minecraft/bot-queries");
		return (mod as { getNearbyBlockCounts: typeof getNearbyBlockCounts }).getNearbyBlockCounts;
	}

	test("Map<string, number> を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot(["stone", "stone", "dirt"]);
		const result = fn(bot, 2);
		expect(result).toBeInstanceOf(Map);
		expect(result.get("stone")).toBeGreaterThan(0);
	});

	test("air が結果から除外されること", async () => {
		const fn = await getFn();
		const bot = makeBot(["air", "stone", "air", "air"]);
		const result = fn(bot, 2);
		expect(result.has("air")).toBe(false);
		expect(result.has("stone")).toBe(true);
	});

	test("cave_air が結果から除外されること", async () => {
		const fn = await getFn();
		const bot = makeBot(["cave_air", "stone", "cave_air"]);
		const result = fn(bot, 2);
		expect(result.has("cave_air")).toBe(false);
	});

	test("void_air が結果から除外されること", async () => {
		const fn = await getFn();
		const bot = makeBot(["void_air", "stone"]);
		const result = fn(bot, 2);
		expect(result.has("void_air")).toBe(false);
	});

	test("null を返すブロック位置は無視されること", async () => {
		const fn = await getFn();
		const bot = makeBot([null, "stone", null]);
		const result = fn(bot, 2);
		expect(result.has("stone")).toBe(true);
	});

	test("結果がカウント降順でソートされていること", async () => {
		const fn = await getFn();
		// stone x4, dirt x2, gravel x1 になるブロック列
		const bot = makeBot(["stone", "stone", "stone", "stone", "dirt", "dirt", "gravel"]);
		const result = fn(bot, 2);
		const entries = [...result.entries()];
		// カウント降順であること
		for (let i = 0; i < entries.length - 1; i++) {
			expect(entries[i]?.[1]).toBeGreaterThanOrEqual(entries[i + 1]?.[1] ?? 0);
		}
	});

	test("すべて air の場合は空 Map を返すこと", async () => {
		const fn = await getFn();
		const bot = makeBot(["air", "cave_air", "void_air"]);
		const result = fn(bot, 2);
		expect(result.size).toBe(0);
	});
});
