import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { z } from "zod";

import type { JobManager } from "../job-manager.ts";
import {
	type GetBot,
	collectBedIds,
	ensureMovements,
	registerAbortHandler,
	textResult,
} from "./shared.ts";

/** 食料アイテム（緊急用が先頭、残りは回復量降順） */
const FOOD_ITEMS: string[] = [
	"golden_apple",
	"enchanted_golden_apple",
	"cooked_beef",
	"cooked_porkchop",
	"cooked_mutton",
	"cooked_salmon",
	"cooked_chicken",
	"golden_carrot",
	"bread",
	"cooked_cod",
	"baked_potato",
	"cooked_rabbit",
	"apple",
	"carrot",
	"melon_slice",
	"sweet_berries",
	"potato",
	"dried_kelp",
];

/** golden_apple 系は緊急時専用 */
const EMERGENCY_ONLY_FOODS = new Set(["golden_apple", "enchanted_golden_apple"]);

function registerEatFood(server: McpServer, getBot: GetBot): void {
	server.tool(
		"eat_food",
		"インベントリから食料を選んで食べる（空腹度を回復）",
		{
			emergency: z
				.boolean()
				.default(false)
				.describe("緊急時のみ true（golden_apple の使用を許可）"),
		},
		async ({ emergency }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			if (bot.food >= 20) return textResult("空腹度は満タンです。食べる必要はありません");

			const inventory = bot.inventory.items();

			for (const foodName of FOOD_ITEMS) {
				if (!emergency && EMERGENCY_ONLY_FOODS.has(foodName)) continue;

				const item = inventory.find((i) => i.name === foodName);
				if (!item) continue;

				try {
					// oxlint-disable-next-line no-await-in-loop -- 最初に見つかった食料で即 return
					await bot.equip(item, "hand");
					// oxlint-disable-next-line no-await-in-loop -- 食事は順次実行が必須
					await bot.consume();
					return textResult(`${foodName} を食べました（空腹度: ${String(bot.food)}/20）`);
				} catch {
					return textResult(
						`${foodName} を食べようとしましたが中断されました（空腹度: ${String(bot.food)}/20）`,
					);
				}
			}

			return textResult("インベントリに食料がありません");
		},
	);
}

function registerFleeFromEntity(server: McpServer, getBot: GetBot, jobManager: JobManager): void {
	server.tool(
		"flee_from_entity",
		"指定エンティティから逃走する（非同期ジョブ: 即座に jobId を返す）",
		{
			entityName: z
				.string()
				.min(1)
				.max(64)
				.describe('逃走対象のエンティティ名（例: "creeper", "warden"）'),
			distance: z
				.number()
				.min(8)
				.max(64)
				.default(32)
				.describe("逃走距離（デフォルト: 32ブロック）"),
		},
		({ entityName, distance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const lowerName = entityName.toLowerCase();
			const target = Object.values(bot.entities).find((e) => e.name?.toLowerCase() === lowerName);
			if (!target) {
				return textResult(`"${entityName}" が周囲に見つかりません。すでに安全かもしれません`);
			}

			const jobId = jobManager.startJob("fleeing", entityName, async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				await bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalFollow(target, distance)));
			});

			return textResult(
				`${entityName} からの逃走を開始しました（jobId: ${jobId}, 距離: ${String(distance)}）`,
			);
		},
	);
}

/** 天井を塞ぐのに適したソリッドブロックの候補（優先度順） */
const SHELTER_BLOCK_NAMES = new Set([
	"cobblestone",
	"dirt",
	"stone",
	"deepslate",
	"cobbled_deepslate",
	"netherrack",
	"sand",
	"gravel",
	"oak_planks",
	"spruce_planks",
	"birch_planks",
	"jungle_planks",
	"acacia_planks",
	"dark_oak_planks",
	"mangrove_planks",
	"cherry_planks",
	"bamboo_planks",
	"crimson_planks",
	"warped_planks",
]);

/** インベントリからシェルター構築に適したソリッドブロックを1つ見つける */
function findPlaceableBlock(bot: mineflayer.Bot) {
	// 優先候補から探す
	const preferred = bot.inventory.items().find((item) => SHELTER_BLOCK_NAMES.has(item.name));
	if (preferred) return preferred;

	// 候補にない場合は、設置可能なソリッドブロックを探す（ツールや非ソリッドを除外）
	return bot.inventory.items().find((item) => {
		const blockDef = bot.registry.blocksByName[item.name];
		return (
			blockDef &&
			blockDef.hardness !== null &&
			blockDef.hardness !== undefined &&
			blockDef.hardness >= 0 &&
			blockDef.boundingBox === "block"
		);
	});
}

/** 穴の入口（頭上）をブロックで塞ぐ。隣接するソリッドブロックを参照に設置する */
async function sealShelterCeiling(bot: mineflayer.Bot, ceilPos: Vec3): Promise<void> {
	const ceilBlock = bot.blockAt(ceilPos);
	if (!ceilBlock || (ceilBlock.name !== "air" && ceilBlock.name !== "cave_air")) return;

	const placeableBlock = findPlaceableBlock(bot);
	if (!placeableBlock) return;

	await bot.equip(placeableBlock, "hand");

	// 隣接ブロックから参照可能なソリッドブロックを探す（縦穴では壁ブロックが参照になる）
	const directions = [
		new Vec3(1, 0, 0),
		new Vec3(-1, 0, 0),
		new Vec3(0, 0, 1),
		new Vec3(0, 0, -1),
		new Vec3(0, -1, 0),
		new Vec3(0, 1, 0),
	];
	for (const dir of directions) {
		const refBlock = bot.blockAt(ceilPos.plus(dir));
		if (refBlock && refBlock.name !== "air" && refBlock.name !== "cave_air") {
			// oxlint-disable-next-line no-await-in-loop -- 最初に見つかった参照で即 return
			await bot.placeBlock(refBlock, dir.scaled(-1));
			return;
		}
	}
}

/** 緊急シェルター: 足元を3ブロック掘り下げ、頭上をブロックで塞いで待機 */
async function digEmergencyShelter(bot: mineflayer.Bot, signal: AbortSignal): Promise<void> {
	for (let i = 0; i < 3; i++) {
		if (signal.aborted) return;
		const pos = bot.entity.position.floored();
		const block = bot.blockAt(pos.offset(0, -1, 0));
		if (!block || block.name === "air" || block.name === "cave_air") break;
		if (block.hardness === null || block.hardness === undefined || block.hardness < 0) break;
		const tool = bot.pathfinder.bestHarvestTool(block);
		try {
			// oxlint-disable-next-line no-await-in-loop -- 装備は順次実行が必須
			if (tool) await bot.equip(tool, "hand");
			// oxlint-disable-next-line no-await-in-loop -- 掘削は順次実行が必須
			await bot.dig(block);
		} catch {
			break;
		}
	}

	if (signal.aborted) return;
	try {
		// ボットは 2 ブロック高。掘削後の実際の位置から天井位置を算出する
		const currentPos = bot.entity.position.floored();
		await sealShelterCeiling(bot, currentPos.offset(0, 2, 0));
	} catch {
		// 設置失敗は許容（掘削だけでも最低限の効果あり）
	}
}

function registerFindShelter(server: McpServer, getBot: GetBot, jobManager: JobManager): void {
	server.tool(
		"find_shelter",
		"安全な避難場所を探して移動する（ベッド検索 → ベッド付近に移動、なければ足元を掘って緊急シェルター構築）",
		{
			maxDistance: z
				.number()
				.min(1)
				.max(64)
				.default(48)
				.describe("ベッド検索範囲（デフォルト: 48）"),
		},
		({ maxDistance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const jobId = jobManager.startJob("sheltering", "避難場所", async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);

				// 1. ベッドを検索
				const bedIds = collectBedIds(bot);
				const bedBlock =
					bedIds.length > 0 ? bot.findBlock({ matching: bedIds, maxDistance }) : null;

				if (bedBlock) {
					try {
						const { x, y, z: bz } = bedBlock.position;
						await bot.pathfinder.goto(new goals.GoalGetToBlock(x, y, bz));
						return;
					} catch {
						// ベッドに到達できなかった場合は緊急シェルターにフォールバック
					}
				}

				if (signal.aborted) return;

				// 2. ベッドなしまたは到達不能 → 緊急シェルター
				await digEmergencyShelter(bot, signal);
			});

			return textResult(`避難場所の検索を開始しました（jobId: ${jobId}）`);
		},
	);
}

export function registerSurvivalTools(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	registerEatFood(server, getBot);
	registerFleeFromEntity(server, getBot, jobManager);
	registerFindShelter(server, getBot, jobManager);
}
