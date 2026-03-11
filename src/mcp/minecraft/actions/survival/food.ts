import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { z } from "zod";

import type { GetBot } from "../shared.ts";
import { textResult } from "../shared.ts";

export interface FoodInfo {
	name: string;
	foodPoints: number;
	effectiveQuality: number;
	saturation: number;
}

/** golden_apple 系は緊急時専用 */
const EMERGENCY_ONLY_FOODS = new Set(["golden_apple", "enchanted_golden_apple"]);
const HARMFUL_FOODS = new Set([
	"rotten_flesh",
	"spider_eye",
	"poisonous_potato",
	"pufferfish",
	"chicken",
]);

function getFoodsByName(bot: mineflayer.Bot): Record<string, FoodInfo> {
	return (
		(
			bot.registry as mineflayer.Bot["registry"] & {
				foodsByName?: Record<string, FoodInfo>;
			}
		).foodsByName ?? {}
	);
}

export function listEdibleFoods(bot: mineflayer.Bot, emergency: boolean): FoodInfo[] {
	const foodsByName = getFoodsByName(bot);
	return Object.values(foodsByName)
		.filter((food) => emergency || !EMERGENCY_ONLY_FOODS.has(food.name))
		.filter((food) => emergency || !HARMFUL_FOODS.has(food.name))
		.toSorted((a, b) => {
			if (EMERGENCY_ONLY_FOODS.has(a.name) !== EMERGENCY_ONLY_FOODS.has(b.name)) {
				return EMERGENCY_ONLY_FOODS.has(a.name) ? -1 : 1;
			}
			if (a.effectiveQuality !== b.effectiveQuality) {
				return b.effectiveQuality - a.effectiveQuality;
			}
			if (a.foodPoints !== b.foodPoints) {
				return b.foodPoints - a.foodPoints;
			}
			return a.name.localeCompare(b.name);
		});
}

export function registerEatFood(server: McpServer, getBot: GetBot): void {
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

			for (const food of listEdibleFoods(bot, emergency)) {
				const item = inventory.find((i) => i.name === food.name);
				if (!item) continue;

				try {
					// oxlint-disable-next-line no-await-in-loop -- 最初に見つかった食料で即 return
					await bot.equip(item, "hand");
					// oxlint-disable-next-line no-await-in-loop -- 食事は順次実行が必須
					await bot.consume();
					return textResult(`${food.name} を食べました（空腹度: ${String(bot.food)}/20）`);
				} catch {
					return textResult(
						`${food.name} を食べようとしましたが中断されました（空腹度: ${String(bot.food)}/20）`,
					);
				}
			}

			return textResult("インベントリに食料がありません");
		},
	);
}
