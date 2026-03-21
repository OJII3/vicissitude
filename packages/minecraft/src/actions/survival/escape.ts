import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pathfinderPkg from "mineflayer-pathfinder";
import { z } from "zod";

import { findPerceivedEntityByName } from "../../bot-queries.ts";
import type { JobManager } from "../../job-manager.ts";
import {
	type GetBot,
	ensureMovements,
	registerAbortHandler,
	textResult,
	tryStartJob,
} from "../shared.ts";

const { goals } = pathfinderPkg;

export function registerFleeFromEntity(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	server.registerTool(
		"flee_from_entity",
		{
			description: "指定エンティティから逃走する（非同期ジョブ: 即座に jobId を返す）",
			inputSchema: {
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
		},
		async ({ entityName, distance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const target = await findPerceivedEntityByName(bot, entityName, distance + 16);
			if (!target) {
				return textResult(
					`"${entityName}" が近距離または視界内に見つかりません。すでに安全かもしれません`,
				);
			}

			const started = tryStartJob(jobManager, "fleeing", entityName, async (signal) => {
				ensureMovements(bot);
				registerAbortHandler(bot, signal);
				await bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalFollow(target, distance)));
			});
			if (!started.ok) return started.result;

			return textResult(
				`${entityName} からの逃走を開始しました（jobId: ${started.jobId}, 距離: ${String(distance)}）`,
			);
		},
	);
}
