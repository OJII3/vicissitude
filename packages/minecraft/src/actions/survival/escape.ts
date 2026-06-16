import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { findPerceivedEntityByName } from "../../bot-queries.ts";
import type { JobManager } from "../../job-manager.ts";
import {
	type GetBot,
	createFleeGoal,
	ensureMovements,
	registerAbortHandler,
	textResult,
	tryStartJob,
	withConnectedBot,
} from "../shared.ts";

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
		withConnectedBot(
			getBot,
			async (bot, { entityName, distance }: { entityName: string; distance: number }) => {
				const target = await findPerceivedEntityByName(bot, entityName, distance + 16);
				if (!target) {
					return textResult(
						`"${entityName}" が近距離または視界内に見つかりません。すでに安全かもしれません`,
					);
				}

				const started = tryStartJob(jobManager, "fleeing", entityName, async (signal) => {
					ensureMovements(bot);
					registerAbortHandler(bot, signal);
					await bot.pathfinder.goto(createFleeGoal(target, distance));
				});
				if (!started.ok) return started.result;

				return textResult(
					`${entityName} からの逃走を開始しました（jobId: ${started.jobId}, 距離: ${String(distance)}）`,
				);
			},
		),
	);
}
