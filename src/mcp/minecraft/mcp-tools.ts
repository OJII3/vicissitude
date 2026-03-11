import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { METRIC } from "../../core/constants.ts";
import type { MetricsCollector } from "../../core/types.ts";
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
	server.tool(
		"observe_state",
		"Minecraft ボットの現在の状態を自然言語要約で取得する",
		{},
		async () => {
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
				nearbyEntities: await getNearbyEntities(bot, 5),
				inventory: getInventorySummary(bot),
				equipment: getEquipment(bot),
				recentEvents: ctx.getEvents().slice(-10),
			});

			return { content: [{ type: "text", text: summary }] };
		},
	);
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
			const text = formatJobStatus(current, recent, jobManager.getCooldowns());
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

/**
 * server.tool() 呼び出しをインターセプトし、各ツールのハンドラ実行時にメトリクスを記録する
 * Proxy を使って McpServer を薄くラップすることで、個々のツール登録関数を変更せずに全ツールを計測できる
 */
function wrapServerWithMetrics(server: McpServer, metrics: MetricsCollector): McpServer {
	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop !== "tool") return Reflect.get(target, prop, receiver);
			// oxlint-disable-next-line no-explicit-any -- McpServer.tool() は複数オーバーロードを持つため any で受ける
			return (name: string, ...args: any[]) => {
				const lastIdx = args.length - 1;
				const originalHandler = args[lastIdx];
				if (typeof originalHandler === "function") {
					// oxlint-disable-next-line no-explicit-any -- handler の引数型はオーバーロードごとに異なる
					args[lastIdx] = (...handlerArgs: any[]) => {
						metrics.incrementCounter(METRIC.MC_MCP_TOOL_CALLS, { tool: name });
						return originalHandler(...handlerArgs);
					};
				}
				// oxlint-disable-next-line no-unsafe-function-type, ban-types -- target.tool の型を正確に表現できないため
				return (target.tool as (...a: unknown[]) => unknown).call(target, name, ...args);
			};
		},
	});
}

export function registerMinecraftTools(
	server: McpServer,
	ctx: BotContext,
	jobManager: JobManager,
	viewerPort: number,
	metrics?: MetricsCollector,
): void {
	const s = metrics ? wrapServerWithMetrics(server, metrics) : server;
	registerObserveStateTool(s, ctx);
	registerRecentEventsTool(s, ctx);
	registerActionTools(s, () => ctx.getBot(), jobManager);
	registerJobStatusTool(s, jobManager);
	registerViewerUrlTool(s, ctx, viewerPort);
}
