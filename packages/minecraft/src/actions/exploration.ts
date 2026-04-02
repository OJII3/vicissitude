import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { z } from "zod";

import type { JobManager } from "../job-manager.ts";
import {
	type GetBot,
	ensureMovements,
	registerAbortHandler,
	textResult,
	tryStartJob,
} from "./shared.ts";

const { goals } = pathfinderPkg;

const SEARCH_RADII = [16, 32, 64, 128, 256];

function searchForBlockSync(params: {
	bot: mineflayer.Bot;
	blockId: number;
	blockName: string;
	maxRadius: number;
	signal: AbortSignal;
	updateProgress: (progress: string) => void;
}): void {
	const { bot, blockId, blockName, maxRadius, signal, updateProgress } = params;
	const radii = SEARCH_RADII.filter((r) => r <= maxRadius);
	if (!radii.includes(maxRadius)) radii.push(maxRadius);

	for (const radius of radii) {
		if (signal.aborted) break;
		updateProgress(`半径 ${String(radius)} ブロックを探索中`);
		const positions = bot.findBlocks({ matching: blockId, maxDistance: radius, count: 1 });
		if (positions.length > 0) {
			const pos = positions.at(0);
			if (pos) updateProgress(`発見: (${String(pos.x)}, ${String(pos.y)}, ${String(pos.z)})`);
			return;
		}
	}
	throw new Error(`${blockName} が半径 ${String(maxRadius)} ブロック以内に見つかりません`);
}

export function registerSearchForBlock(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.registerTool(
		"search_for_block",
		{
			description:
				"指定ブロックを段階的に探索範囲を広げて検索する（非同期ジョブ: 即座に jobId を返す、採集はしない）",
			inputSchema: {
				blockName: z.string().describe('検索するブロック名（例: "diamond_ore", "oak_log"）'),
				maxRadius: z
					.number()
					.min(16)
					.max(256)
					.default(128)
					.describe("最大探索半径（デフォルト: 128）"),
			},
		},
		({ blockName, maxRadius }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");
			const blockType = bot.registry.blocksByName[blockName];
			if (!blockType) return textResult(`不明なブロック名: "${blockName}"`);

			const started = tryStartJob(jobManager, "searching", blockName, (signal, updateProgress) => {
				searchForBlockSync({
					bot,
					blockId: blockType.id,
					blockName,
					maxRadius,
					signal,
					updateProgress,
				});
				return Promise.resolve();
			});
			if (!started.ok) return started.result;
			return textResult(
				`${blockName} の探索を開始しました（jobId: ${started.jobId}, 最大半径: ${String(maxRadius)}）`,
			);
		},
	);
}

const DIRECTION_OFFSETS: Record<string, { x: number; z: number }> = {
	north: { x: 0, z: -1 },
	south: { x: 0, z: 1 },
	east: { x: 1, z: 0 },
	west: { x: -1, z: 0 },
};
const DIRECTION_NAMES = Object.keys(DIRECTION_OFFSETS);

export function registerExploreDirection(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.registerTool(
		"explore_direction",
		{
			description: "指定方向に移動して新しいエリアを開拓する（非同期ジョブ: 即座に jobId を返す）",
			inputSchema: {
				direction: z
					.enum(["north", "south", "east", "west"])
					.optional()
					.describe("移動方向（省略時: ランダム）"),
				distance: z.number().min(16).max(256).default(100).describe("移動距離（デフォルト: 100）"),
			},
		},
		({ direction, distance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const dir =
				direction ?? DIRECTION_NAMES[Math.floor(Math.random() * DIRECTION_NAMES.length)] ?? "north";
			const offset = DIRECTION_OFFSETS[dir] ?? { x: 0, z: -1 };

			const started = tryStartJob(jobManager, "exploring", dir, async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				const pos = bot.entity.position;
				const targetX = pos.x + offset.x * distance;
				const targetZ = pos.z + offset.z * distance;
				await bot.pathfinder.goto(new goals.GoalNear(targetX, pos.y, targetZ, 3));
			});
			if (!started.ok) return started.result;
			return textResult(
				`${dir} 方面への探検を開始しました（jobId: ${started.jobId}, 距離: ${String(distance)}）`,
			);
		},
	);
}
