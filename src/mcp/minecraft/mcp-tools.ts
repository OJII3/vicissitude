import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerActionTools } from "./actions/index.ts";
import type { BotContext } from "./bot-context.ts";
import {
	IMPORTANCE_ORDER,
	getEquipment,
	getInventorySummary,
	getNearbyEntities,
	getTimePeriod,
	getWeather,
} from "./bot-queries.ts";
import type { JobManager } from "./job-manager.ts";
import { formatEvents, formatJobStatus, summarizeState } from "./state-summary.ts";

function registerObserveStateTool(server: McpServer, ctx: BotContext): void {
	server.tool("observe_state", "Minecraft ボットの現在の状態を自然言語要約で取得する", {}, () => {
		const bot = ctx.getBot();
		if (!bot || !bot.entity) {
			return { content: [{ type: "text", text: "ボット未接続" }] };
		}

		const pos = bot.entity.position;
		const timeOfDay = bot.time?.timeOfDay;
		const summary = summarizeState({
			position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
			health: bot.health,
			food: bot.food,
			timePeriod: timeOfDay === undefined ? "不明" : getTimePeriod(timeOfDay),
			weather: getWeather(bot),
			action: { ...ctx.getActionState() },
			nearbyEntities: getNearbyEntities(bot, 5),
			inventory: getInventorySummary(bot),
			equipment: getEquipment(bot),
			recentEvents: ctx.getEvents().slice(-10),
		});

		return { content: [{ type: "text", text: summary }] };
	});
}

function registerRecentEventsTool(server: McpServer, ctx: BotContext): void {
	server.tool(
		"get_recent_events",
		"Minecraft ボットの直近イベントログをテキスト形式で取得する",
		{
			limit: z
				.number()
				.min(1)
				.max(50)
				.default(10)
				.describe("取得するイベント数（デフォルト: 10、最大: 50）"),
			importance: z
				.enum(["low", "medium", "high"])
				.optional()
				.describe("最低重要度フィルタ（例: medium → medium 以上のみ）"),
		},
		({ limit, importance }) => {
			const events = ctx.getEvents();
			let filtered = events;
			if (importance) {
				const threshold = IMPORTANCE_ORDER[importance];
				filtered = events.filter((e) => IMPORTANCE_ORDER[e.importance] >= threshold);
			}
			const recent = filtered.slice(-limit);
			return { content: [{ type: "text", text: formatEvents(recent) }] };
		},
	);
}

function registerJobStatusTool(server: McpServer, jobManager: JobManager): void {
	server.tool(
		"get_job_status",
		"現在のジョブ状態と直近のジョブ履歴を取得する",
		{
			limit: z
				.number()
				.min(1)
				.max(20)
				.default(5)
				.describe("取得するジョブ履歴数（デフォルト: 5、最大: 20）"),
		},
		({ limit }) => {
			const current = jobManager.getCurrentJob();
			const recent = jobManager.getRecentJobs(limit);
			const text = formatJobStatus(current, recent);
			return { content: [{ type: "text", text }] };
		},
	);
}

function registerViewerUrlTool(server: McpServer, ctx: BotContext, viewerPort: number): void {
	server.tool("get_viewer_url", "Minecraft ビューアーの URL を返す", {}, () => {
		const bot = ctx.getBot();
		if (!bot?.entity) {
			return { content: [{ type: "text" as const, text: "ボット未接続" }] };
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `http://localhost:${String(viewerPort)}`,
				},
			],
		};
	});
}

export function registerMinecraftTools(
	server: McpServer,
	ctx: BotContext,
	jobManager: JobManager,
	viewerPort: number,
): void {
	registerObserveStateTool(server, ctx);
	registerRecentEventsTool(server, ctx);
	registerActionTools(server, () => ctx.getBot(), jobManager);
	registerJobStatusTool(server, jobManager);
	registerViewerUrlTool(server, ctx, viewerPort);
}
