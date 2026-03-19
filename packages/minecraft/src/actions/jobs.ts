import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import type { Furnace } from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import type { Recipe } from "prismarine-recipe";
import { z } from "zod";

import type { JobManager } from "../job-manager.ts";
import {
	type GetBot,
	collectBedIds,
	ensureMovements,
	registerAbortHandler,
	textResult,
	tryStartJob,
} from "./shared.ts";

const MAX_CRAFT_COUNT = 64;

/** レシピを検索し、作業台が必要かどうかも返す */
function findRecipe(
	bot: mineflayer.Bot,
	itemId: number,
): { recipe: Recipe; needTable: boolean } | null {
	const recipes = bot.recipesFor(itemId, null, null, false);
	const first = recipes[0];
	if (first) return { recipe: first, needTable: false };

	const tableRecipes = bot.recipesFor(itemId, null, null, true);
	const firstTable = tableRecipes[0];
	if (firstTable) return { recipe: firstTable, needTable: true };

	return null;
}

/** wake イベントまたは abort で解決する Promise を返す */
function waitForWakeOrAbort(bot: mineflayer.Bot, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		const onWake = () => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = () => {
			bot.removeListener("wake", onWake);
			void bot.wake().catch((err) => {
				console.error(
					`[minecraft] wake failed during abort: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
			resolve();
		};
		bot.once("wake", onWake);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function executeCraft(
	bot: mineflayer.Bot,
	itemId: number,
	itemName: string,
	count: number,
	signal: AbortSignal,
): Promise<void> {
	const result = findRecipe(bot, itemId);
	if (!result) throw new Error(`${itemName} のレシピが見つからないか、材料が足りません`);

	if (!result.needTable) {
		await bot.craft(result.recipe, count);
		return;
	}

	if (signal.aborted) return;

	const table = bot.findBlock({
		matching: bot.registry.blocksByName["crafting_table"]?.id ?? -1,
		maxDistance: 32,
	});
	if (!table) throw new Error("近くに作業台が見つかりません（32 ブロック以内）");

	const { x, y, z: cz } = table.position;
	await bot.pathfinder.goto(new goals.GoalGetToBlock(x, y, cz));

	if (signal.aborted) return;
	await bot.craft(result.recipe, count, table);
}

async function executeSleep(
	bot: mineflayer.Bot,
	bedIds: number[],
	maxDistance: number,
	signal: AbortSignal,
): Promise<void> {
	const bedBlock = bot.findBlock({ matching: bedIds, maxDistance });
	if (!bedBlock) throw new Error(`${String(maxDistance)} ブロック以内にベッドが見つかりません`);

	const { x, y, z: bz } = bedBlock.position;
	await bot.pathfinder.goto(new goals.GoalGetToBlock(x, y, bz));

	if (signal.aborted) return;

	const current = bot.blockAt(bedBlock.position);
	if (!current || !bedIds.includes(current.type)) {
		throw new Error("ベッドに到着しましたが、ベッドがなくなっています");
	}

	await bot.sleep(current);
	await waitForWakeOrAbort(bot, signal);
}

export function registerCraftItem(server: McpServer, getBot: GetBot, jobManager: JobManager): void {
	server.tool(
		"craft_item",
		"指定アイテムをクラフトする（非同期ジョブ: 即座に jobId を返す、作業台が必要な場合は自動で移動）",
		{
			itemName: z.string().describe('クラフトするアイテム名（例: "stick", "crafting_table"）'),
			count: z
				.number()
				.int()
				.min(1)
				.max(MAX_CRAFT_COUNT)
				.default(1)
				.describe(`クラフト個数（デフォルト: 1、最大: ${String(MAX_CRAFT_COUNT)}）`),
		},
		({ itemName, count }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const itemType = bot.registry.itemsByName[itemName];
			if (!itemType) return textResult(`不明なアイテム名: "${itemName}"`);

			const started = tryStartJob(jobManager, "crafting", itemName, async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				await executeCraft(bot, itemType.id, itemName, count, signal);
			});
			if (!started.ok) return started.result;

			return textResult(
				`${itemName} のクラフトを開始しました（jobId: ${started.jobId}, 目標: ${String(count)} 個）`,
			);
		},
	);
}

export function registerSleepInBed(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.tool(
		"sleep_in_bed",
		"近くのベッドで就寝を試みる（非同期ジョブ: 即座に jobId を返す）",
		{
			maxDistance: z
				.number()
				.min(1)
				.max(64)
				.default(32)
				.describe("ベッド検索範囲（デフォルト: 32、最大: 64）"),
		},
		({ maxDistance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const bedIds = collectBedIds(bot);
			if (bedIds.length === 0) return textResult("ベッドブロックの定義が見つかりません");

			const started = tryStartJob(jobManager, "sleeping", "ベッド", async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				await executeSleep(bot, bedIds, maxDistance, signal);
			});
			if (!started.ok) return started.result;

			return textResult(`就寝を開始しました（jobId: ${started.jobId}）`);
		},
	);
}

const SMELT_TIMEOUT_PER_ITEM_MS = 12_000;
const SMELT_TIMEOUT_BUFFER_MS = 5_000;
const MAX_SMELT_COUNT = 64;
const FURNACE_SEARCH_DISTANCE = 32;

/** かまどブロック ID（furnace / lit_furnace）を収集する */
function collectFurnaceIds(bot: mineflayer.Bot): number[] {
	const ids: number[] = [];
	for (const name of ["furnace", "lit_furnace"]) {
		const block = bot.registry.blocksByName[name];
		if (block) ids.push(block.id);
	}
	return ids;
}

/** 精錬完了（outputItem の count が目標に達する）を待機する */
function waitForSmeltComplete(
	furnace: Furnace,
	targetCount: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timeoutMs = targetCount * SMELT_TIMEOUT_PER_ITEM_MS + SMELT_TIMEOUT_BUFFER_MS;
		const timeout = setTimeout(() => {
			cleanup();
			const output = furnace.outputItem();
			const got = output ? output.count : 0;
			reject(
				new Error(
					`精錬がタイムアウトしました（${String(got)}/${String(targetCount)} 個完了）。燃料不足の可能性があります`,
				),
			);
		}, timeoutMs);

		const onUpdate = () => {
			const output = furnace.outputItem();
			if (output && output.count >= targetCount) {
				cleanup();
				resolve();
			}
		};

		const onAbort = () => {
			cleanup();
			resolve();
		};

		const cleanup = () => {
			clearTimeout(timeout);
			furnace.removeListener("update", onUpdate);
			signal.removeEventListener("abort", onAbort);
		};

		furnace.on("update", onUpdate);
		signal.addEventListener("abort", onAbort, { once: true });

		onUpdate();
	});
}

interface SmeltParams {
	bot: mineflayer.Bot;
	itemId: number;
	fuelId: number;
	fuelName: string;
	count: number;
	signal: AbortSignal;
}

async function executeSmelt(params: SmeltParams): Promise<void> {
	const { bot, itemId, fuelId, fuelName, count, signal } = params;
	const furnaceIds = collectFurnaceIds(bot);
	if (furnaceIds.length === 0) throw new Error("かまどブロックの定義が見つかりません");

	const furnaceBlock = bot.findBlock({
		matching: furnaceIds,
		maxDistance: FURNACE_SEARCH_DISTANCE,
	});
	if (!furnaceBlock)
		throw new Error(
			`近くにかまどが見つかりません（${String(FURNACE_SEARCH_DISTANCE)} ブロック以内）`,
		);

	const { x, y, z: fz } = furnaceBlock.position;
	await bot.pathfinder.goto(new goals.GoalGetToBlock(x, y, fz));

	if (signal.aborted) return;

	const furnace = await bot.openFurnace(furnaceBlock);
	try {
		// 既存の output を先に回収し、完了判定の誤検知を防ぐ
		if (furnace.outputItem()) {
			await furnace.takeOutput();
		}

		if (!furnace.fuelItem()) {
			const fuelInInventory = bot.inventory.items().find((i) => i.name === fuelName);
			if (!fuelInInventory) throw new Error(`インベントリに燃料 "${fuelName}" がありません`);
			await furnace.putFuel(fuelId, null, Math.min(fuelInInventory.count, count));
		}

		if (signal.aborted) return;

		await furnace.putInput(itemId, null, count);

		if (signal.aborted) return;

		await waitForSmeltComplete(furnace, count, signal);

		if (signal.aborted) return;

		await furnace.takeOutput();
	} finally {
		furnace.close();
	}
}

export function registerSmeltItem(server: McpServer, getBot: GetBot, jobManager: JobManager): void {
	server.tool(
		"smelt_item",
		"かまどでアイテムを精錬する（非同期ジョブ: 即座に jobId を返す、近くのかまどまで自動で移動）",
		{
			itemName: z
				.string()
				.describe('精錬するアイテム名（例: "raw_iron", "raw_gold", "cobblestone"）'),
			count: z
				.number()
				.int()
				.min(1)
				.max(MAX_SMELT_COUNT)
				.default(1)
				.describe(`精錬個数（デフォルト: 1、最大: ${String(MAX_SMELT_COUNT)}）`),
			fuelName: z
				.string()
				.default("coal")
				.describe('燃料アイテム名（デフォルト: "coal"、例: "charcoal", "oak_planks"）'),
		},
		({ itemName, count, fuelName }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const itemType = bot.registry.itemsByName[itemName];
			if (!itemType) return textResult(`不明なアイテム名: "${itemName}"`);

			const fuelType = bot.registry.itemsByName[fuelName];
			if (!fuelType) return textResult(`不明な燃料名: "${fuelName}"`);

			const itemInInventory = bot.inventory.items().find((i) => i.name === itemName);
			if (!itemInInventory) return textResult(`インベントリに "${itemName}" がありません`);

			const started = tryStartJob(jobManager, "smelting", itemName, async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				await executeSmelt({
					bot,
					itemId: itemType.id,
					fuelId: fuelType.id,
					fuelName,
					count,
					signal,
				});
			});
			if (!started.ok) return started.result;

			return textResult(
				`${itemName} の精錬を開始しました（jobId: ${started.jobId}, 目標: ${String(count)} 個, 燃料: ${fuelName}）`,
			);
		},
	);
}
