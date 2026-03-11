import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { z } from "zod";

import type { JobManager } from "../../job-manager.ts";
import {
	type GetBot,
	collectBedIds,
	ensureMovements,
	registerAbortHandler,
	textResult,
	tryStartJob,
} from "../shared.ts";

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

function findPlaceableBlock(bot: mineflayer.Bot) {
	const preferred = bot.inventory.items().find((item) => SHELTER_BLOCK_NAMES.has(item.name));
	if (preferred) return preferred;

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

async function sealShelterCeiling(bot: mineflayer.Bot, ceilPos: Vec3): Promise<void> {
	const ceilBlock = bot.blockAt(ceilPos);
	if (!ceilBlock || (ceilBlock.name !== "air" && ceilBlock.name !== "cave_air")) return;

	const placeableBlock = findPlaceableBlock(bot);
	if (!placeableBlock) return;

	await bot.equip(placeableBlock, "hand");

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
		const currentPos = bot.entity.position.floored();
		await sealShelterCeiling(bot, currentPos.offset(0, 2, 0));
	} catch {
		// 設置失敗は許容（掘削だけでも最低限の効果あり）
	}
}

export function registerFindShelter(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
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

			const started = tryStartJob(jobManager, "sheltering", "避難場所", async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);

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
				await digEmergencyShelter(bot, signal);
			});
			if (!started.ok) return started.result;

			return textResult(`避難場所の検索を開始しました（jobId: ${started.jobId}）`);
		},
	);
}
