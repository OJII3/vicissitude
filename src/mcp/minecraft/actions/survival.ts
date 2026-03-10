import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { goals } from "mineflayer-pathfinder";
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

				// oxlint-disable-next-line no-await-in-loop -- 最初に見つかった食料で即 return
				await bot.equip(item, "hand");
				// oxlint-disable-next-line no-await-in-loop -- 食事は順次実行が必須
				await bot.consume();
				return textResult(`${foodName} を食べました（空腹度: ${String(bot.food)}/20）`);
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

/** 緊急シェルター: 足元を3ブロック掘り下げて待機 */
async function digEmergencyShelter(bot: mineflayer.Bot, signal: AbortSignal): Promise<void> {
	for (let i = 0; i < 3; i++) {
		if (signal.aborted) return;
		// 落下後の位置を毎回再取得する
		const pos = bot.entity.position.floored();
		const block = bot.blockAt(pos.offset(0, -1, 0));
		if (!block || block.name === "air" || block.name === "cave_air") break;
		// 破壊不可能ブロック（bedrock 等）はスキップ
		if (block.hardness < 0) break;
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

			const jobId = jobManager.startJob("moving", "避難場所", async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);

				// 1. ベッドを検索
				const bedIds = collectBedIds(bot);
				const bedBlock =
					bedIds.length > 0 ? bot.findBlock({ matching: bedIds, maxDistance }) : null;

				if (bedBlock) {
					const { x, y, z: bz } = bedBlock.position;
					await bot.pathfinder.goto(new goals.GoalGetToBlock(x, y, bz));
					return;
				}

				if (signal.aborted) return;

				// 2. ベッドなし → 緊急シェルター
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
