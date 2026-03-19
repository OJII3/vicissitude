import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { METRIC } from "@vicissitude/shared/constants";
import type { Logger, MetricsCollector } from "@vicissitude/shared/types";
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
import { attemptStuckRecovery, respawnWithRetry } from "./stuck-recovery.ts";

function registerObserveStateTool(
	server: McpServer,
	ctx: BotContext,
	jobManager: JobManager,
	stuckRecovery?: MinecraftToolsOptions["stuckRecovery"],
): void {
	server.registerTool(
		"observe_state",
		{ description: "Minecraft ボットの現在の状態を自然言語要約で取得する" },
		async () => {
			const bot = ctx.getBot();
			if (!bot || !bot.entity) {
				return { content: [{ type: "text", text: "ボット未接続" }] };
			}

			// 死亡画面でスタックしている場合、リスポーンリトライを試みる
			if (bot.health <= 0) {
				const ok = await respawnWithRetry(ctx);
				return {
					content: [
						{
							type: "text",
							text: ok
								? "ボットは死亡状態でしたが、リスポーンに成功しました。再度確認してください。"
								: "ボットは死亡状態です。リスポーンに失敗しました。",
						},
					],
				};
			}

			const pos = bot.entity.position;
			const timeOfDay = bot.time?.timeOfDay;
			const roundedPos = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
			jobManager.recordPositionSnapshot(roundedPos);
			const stuckResult = jobManager.isStuck();

			let stuckRecoveryNote: string | undefined;
			if (stuckResult.stuck && stuckRecovery) {
				const recovered = await attemptStuckRecovery({
					ctx,
					reconnect: stuckRecovery.reconnect,
					onRecoverySuccess: stuckRecovery.onRecoverySuccess,
					cooldownMs: stuckRecovery.cooldownMs,
				});
				stuckRecoveryNote = recovered
					? "スタック復帰: リスポーン/移動に成功"
					: "スタック復帰: 再接続をトリガー";
			}

			const summary = summarizeState({
				position: roundedPos,
				health: bot.health,
				food: bot.food,
				timePeriod: timeOfDay === undefined ? "不明" : getTimePeriod(timeOfDay),
				weather: getWeather(bot),
				action: { ...ctx.getActionState() },
				nearbyEntities: await getNearbyEntities(bot, 5),
				inventory: getInventorySummary(bot),
				equipment: getEquipment(bot),
				recentEvents: ctx.getEvents().slice(-10),
				stuckWarning: stuckResult.stuck
					? [stuckResult.reason, stuckRecoveryNote].filter(Boolean).join(" / ")
					: undefined,
			});

			return { content: [{ type: "text", text: summary }] };
		},
	);
}

function registerRecentEventsTool(server: McpServer, ctx: BotContext): void {
	server.registerTool(
		"get_recent_events",
		{
			description: "Minecraft ボットの直近イベントログをテキスト形式で取得する",
			inputSchema: {
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
	server.registerTool(
		"get_job_status",
		{
			description: "現在のジョブ状態と直近のジョブ履歴を取得する",
			inputSchema: {
				limit: z
					.number()
					.min(1)
					.max(20)
					.default(5)
					.describe("取得するジョブ履歴数（デフォルト: 5、最大: 20）"),
			},
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
	server.registerTool(
		"get_viewer_url",
		{ description: "Minecraft ビューアーの URL を返す" },
		() => {
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
		},
	);
}

/**
 * server.registerTool() 呼び出しをインターセプトし、各ツールのハンドラ実行時にメトリクスを記録する
 * Proxy を使って McpServer を薄くラップすることで、個々のツール登録関数を変更せずに全ツールを計測できる
 */
function wrapServerWithMetrics(server: McpServer, metrics: MetricsCollector): McpServer {
	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
			// oxlint-disable-next-line no-explicit-any -- McpServer.registerTool() のコールバック型を正確に表現できないため any で受ける
			return (name: string, config: any, cb: (...handlerArgs: any[]) => any) => {
				// oxlint-disable-next-line no-explicit-any -- handler の引数型はツールごとに異なる
				const wrappedCb = (...handlerArgs: any[]) => {
					metrics.incrementCounter(METRIC.MC_MCP_TOOL_CALLS, { tool: name });
					return cb(...handlerArgs);
				};
				return target.registerTool(name, config, wrappedCb);
			};
		},
	});
}

interface MinecraftToolsOptions {
	metrics?: MetricsCollector;
	logger: Logger;
	stuckRecovery?: {
		reconnect: () => void;
		onRecoverySuccess: () => void;
		cooldownMs?: number;
	};
}

export function registerMinecraftTools(
	server: McpServer,
	ctx: BotContext,
	jobManager: JobManager,
	viewerPort: number,
	options: MinecraftToolsOptions,
): void {
	const s = options.metrics ? wrapServerWithMetrics(server, options.metrics) : server;
	registerObserveStateTool(s, ctx, jobManager, options.stuckRecovery);
	registerRecentEventsTool(s, ctx);
	registerActionTools(s, () => ctx.getBot(), jobManager, options.logger);
	registerJobStatusTool(s, jobManager);
	registerViewerUrlTool(s, ctx, viewerPort);
}
