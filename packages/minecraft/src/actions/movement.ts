import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import { z } from "zod";

import { canPerceiveEntity, findPerceivedBlock } from "../bot-queries.ts";
import type { JobManager } from "../job-manager.ts";
import {
	type GetBot,
	ensureMovements,
	registerAbortHandler,
	textResult,
	tryStartJob,
} from "./shared.ts";

const { goals } = pathfinderPkg;

const MAX_COLLECT_COUNT = 64;

async function digOneBlock(
	b: mineflayer.Bot,
	blockId: number,
	maxDistance: number,
	signal: AbortSignal,
): Promise<boolean> {
	if (signal.aborted) return false;
	const block = findPerceivedBlock(b, { matching: blockId, maxDistance, count: 24 });
	if (!block) return false;
	const { x, y, z: bz } = block.position;
	await b.pathfinder.goto(new goals.GoalGetToBlock(x, y, bz));

	if (signal.aborted) return false;

	// 移動後にブロックがまだ存在するか再検証
	const current = b.blockAt(block.position);
	if (!current || current.type !== blockId) return false;

	const tool = b.pathfinder.bestHarvestTool(current);
	if (tool) await b.equip(tool, "hand");
	await b.dig(current);
	return true;
}

interface CollectBlockParams {
	bot: mineflayer.Bot;
	blockId: number;
	blockName: string;
	count: number;
	maxDistance: number;
	signal: AbortSignal;
	updateProgress: (progress: string) => void;
}

async function executeCollectBlock(params: CollectBlockParams): Promise<void> {
	const { bot, blockId, blockName, count, maxDistance, signal, updateProgress } = params;
	ensureMovements(bot);
	registerAbortHandler(bot, signal);
	let collected = 0;
	while (collected < count) {
		if (signal.aborted) break;
		// eslint-disable-next-line no-await-in-loop -- ブロック採掘は順次実行が必須
		const dug = await digOneBlock(bot, blockId, maxDistance, signal);
		if (!dug) break;
		collected++;
		updateProgress(`${String(collected)}/${String(count)} 採集済み`);
	}
	if (collected < count && !signal.aborted) {
		throw new Error(
			`${String(collected)}/${String(count)} 個採集 — ${String(maxDistance)} ブロック以内に ${blockName} が見つかりません`,
		);
	}
}

/** 追従ジョブの executor: プレイヤーが離脱するか abort されるまで追従し続ける */
function executeFollow(
	bot: mineflayer.Bot,
	entity: Entity,
	username: string,
	range: number,
	signal: AbortSignal,
): Promise<void> {
	ensureMovements(bot);
	bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);

	return new Promise<void>((resolve) => {
		let done = false;
		const onAbort = () => finish();
		const finish = () => {
			if (done) return;
			done = true;
			bot.pathfinder.stop();
			bot.removeListener("playerLeft", onPlayerLeft);
			bot.removeListener("entityGone", onEntityGone);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const onPlayerLeft = (player: { username: string }) => {
			if (player.username === username) finish();
		};
		const onEntityGone = (e: { id: number }) => {
			if (e.id === entity.id) finish();
		};
		bot.on("playerLeft", onPlayerLeft);
		bot.on("entityGone", onEntityGone);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function registerFollowPlayer(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.registerTool(
		"follow_player",
		{
			description: "指定プレイヤーへの追従を開始する（非同期ジョブ: 即座に jobId を返す）",
			inputSchema: {
				username: z.string().describe("追従対象のプレイヤー名"),
				range: z.number().min(1).default(3).describe("何ブロック以内に接近するか（デフォルト: 3）"),
			},
		},
		async ({ username, range }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const entity = bot.players[username]?.entity;
			if (!entity || !(await canPerceiveEntity(bot, entity))) {
				return textResult(`プレイヤー "${username}" が見つからないか、視界内にいません`);
			}

			const started = tryStartJob(jobManager, "following", username, (signal) =>
				executeFollow(bot, entity, username, range, signal),
			);
			if (!started.ok) return started.result;

			return textResult(
				`${username} への追従を開始しました（jobId: ${started.jobId}, range: ${String(range)}）`,
			);
		},
	);
}

export function registerGoTo(server: McpServer, getBot: GetBot, jobManager: JobManager): void {
	server.registerTool(
		"go_to",
		{
			description: "指定座標への移動を開始する（非同期ジョブ: 即座に jobId を返す）",
			inputSchema: {
				x: z.number().describe("X 座標"),
				y: z.number().describe("Y 座標"),
				z: z.number().describe("Z 座標"),
				range: z.number().min(0).default(2).describe("目標地点からの許容距離（デフォルト: 2）"),
			},
		},
		({ x, y, z: zCoord, range }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const coord = `(${String(x)}, ${String(y)}, ${String(zCoord)})`;

			const started = tryStartJob(jobManager, "moving", coord, async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				await bot.pathfinder.goto(new goals.GoalNear(x, y, zCoord, range));
			});
			if (!started.ok) return started.result;

			return textResult(`${coord} への移動を開始しました（jobId: ${started.jobId}）`);
		},
	);
}

export function registerCollectBlock(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.registerTool(
		"collect_block",
		{
			description:
				"指定ブロックの採集を開始する（非同期ジョブ: 即座に jobId を返す、最適ツール自動装備）",
			inputSchema: {
				blockName: z.string().describe('ブロック名（例: "oak_log", "diamond_ore"）'),
				count: z
					.number()
					.int()
					.min(1)
					.max(MAX_COLLECT_COUNT)
					.default(1)
					.describe(`採集する個数（デフォルト: 1、最大: ${String(MAX_COLLECT_COUNT)}）`),
				maxDistance: z.number().min(1).default(32).describe("検索範囲（デフォルト: 32）"),
			},
		},
		({ blockName, count, maxDistance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const blockType = bot.registry.blocksByName[blockName];
			if (!blockType) return textResult(`不明なブロック名: "${blockName}"`);

			const started = tryStartJob(jobManager, "collecting", blockName, (signal, updateProgress) =>
				executeCollectBlock({
					bot,
					blockId: blockType.id,
					blockName,
					count,
					maxDistance,
					signal,
					updateProgress,
				}),
			);
			if (!started.ok) return started.result;

			return textResult(
				`${blockName} の採集を開始しました（jobId: ${started.jobId}, 目標: ${String(count)} 個）`,
			);
		},
	);
}

export function registerStop(server: McpServer, jobManager: JobManager): void {
	server.registerTool(
		"stop",
		{ description: "現在のジョブ（移動・追従・採集・クラフト・就寝）を停止する" },
		() => {
			const cancelled = jobManager.cancelCurrentJob();
			if (cancelled) {
				return textResult("ジョブを停止しました");
			}
			return textResult("実行中のジョブはありません");
		},
	);
}
