import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@vicissitude/shared/types";
import type mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
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

const { goals } = pathfinderPkg;

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
function waitForWakeOrAbort(
	bot: mineflayer.Bot,
	signal: AbortSignal,
	logger: Logger,
): Promise<void> {
	return new Promise<void>((resolve) => {
		const onWake = () => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = () => {
			bot.removeListener("wake", onWake);
			void bot.wake().catch((err) => {
				logger.error(
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
	logger: Logger,
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
	await waitForWakeOrAbort(bot, signal, logger);
}

export function registerCraftItem(server: McpServer, getBot: GetBot, jobManager: JobManager): void {
	server.registerTool(
		"craft_item",
		{
			description:
				"指定アイテムをクラフトする（非同期ジョブ: 即座に jobId を返す、作業台が必要な場合は自動で移動）",
			inputSchema: {
				itemName: z.string().describe('クラフトするアイテム名（例: "stick", "crafting_table"）'),
				count: z
					.number()
					.int()
					.min(1)
					.max(MAX_CRAFT_COUNT)
					.default(1)
					.describe(`クラフト個数（デフォルト: 1、最大: ${String(MAX_CRAFT_COUNT)}）`),
			},
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
	logger: Logger,
): void {
	server.registerTool(
		"sleep_in_bed",
		{
			description: "近くのベッドで就寝を試みる（非同期ジョブ: 即座に jobId を返す）",
			inputSchema: {
				maxDistance: z
					.number()
					.min(1)
					.max(64)
					.default(32)
					.describe("ベッド検索範囲（デフォルト: 32、最大: 64）"),
			},
		},
		({ maxDistance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const bedIds = collectBedIds(bot);
			if (bedIds.length === 0) return textResult("ベッドブロックの定義が見つかりません");

			const started = tryStartJob(jobManager, "sleeping", "ベッド", async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				await executeSleep(bot, bedIds, maxDistance, signal, logger);
			});
			if (!started.ok) return started.result;

			return textResult(`就寝を開始しました（jobId: ${started.jobId}）`);
		},
	);
}
