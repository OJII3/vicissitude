import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapServerWithMetrics } from "@vicissitude/mcp/tool-metrics";
import { METRIC } from "@vicissitude/observability/metrics";
import type { Logger, MetricsCollector } from "@vicissitude/shared/types";
import { z } from "zod/v4";

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
): void {
	server.registerTool(
		"observe_state",
		{ description: "Minecraft ボットの現在の状態を自然言語要約で取得する" },
		async () => {
			const bot = ctx.getBot();
			if (!bot || !bot.entity) {
				return { content: [{ type: "text", text: "ボット未接続" }] };
			}

			if (bot.health <= 0) {
				return {
					content: [
						{
							type: "text",
							text: "ボットは死亡状態です。観察ではリスポーンしません。復旧するには recover_state を明示実行してください。",
						},
					],
				};
			}

			const pos = bot.entity.position;
			const timeOfDay = bot.time?.timeOfDay;
			const roundedPos = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
			jobManager.recordPositionSnapshot(roundedPos);
			const stuckResult = jobManager.isStuck();

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
					? [stuckResult.reason, "提案: recover_state を明示実行して復旧を試してください"]
							.filter(Boolean)
							.join(" / ")
					: undefined,
			});

			return { content: [{ type: "text", text: summary }] };
		},
	);
}

function registerRecoverStateTool(
	server: McpServer,
	ctx: BotContext,
	jobManager: JobManager,
	stuckRecovery?: MinecraftToolsOptions["stuckRecovery"],
): void {
	server.registerTool(
		"recover_state",
		{ description: "死亡・スタック状態からの復旧を明示的に実行する" },
		async () => {
			const bot = ctx.getBot();
			if (!bot || !bot.entity) {
				return { content: [{ type: "text" as const, text: "ボット未接続" }] };
			}

			if (bot.health <= 0) {
				const ok = await respawnWithRetry(ctx);
				return {
					content: [
						{
							type: "text" as const,
							text: ok
								? "リスポーンに成功しました。再度 observe_state で状態を確認してください。"
								: "リスポーンに失敗しました。接続状態を確認してください。",
						},
					],
				};
			}

			const stuckResult = jobManager.isStuck();
			if (!stuckResult.stuck) {
				return { content: [{ type: "text" as const, text: "復旧対象はありません。" }] };
			}

			const recovered = await attemptStuckRecovery({
				ctx,
				reconnect: stuckRecovery?.reconnect,
				onRecoverySuccess: stuckRecovery?.onRecoverySuccess,
				requestSessionRotation: stuckRecovery?.requestSessionRotation,
				cooldownMs: stuckRecovery?.cooldownMs,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: recovered
							? "スタック復帰に成功しました。再度 observe_state で状態を確認してください。"
							: "スタック復帰に失敗しました。再接続またはセッション再作成が必要な可能性があります。",
					},
				],
			};
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
		({ limit, importance }: { limit: number; importance?: "low" | "medium" | "high" }) => {
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
		({ limit }: { limit: number }) => {
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

interface MinecraftToolsOptions {
	metrics?: MetricsCollector;
	logger: Logger;
	stuckRecovery?: {
		reconnect: () => void;
		onRecoverySuccess: () => void;
		requestSessionRotation?: () => Promise<void>;
		cooldownMs?: number;
	};
}

interface RegisterMinecraftToolsParams {
	server: McpServer;
	ctx: BotContext;
	jobManager: JobManager;
	viewerPort: number;
	options: MinecraftToolsOptions;
}

export function registerMinecraftTools(params: RegisterMinecraftToolsParams): void {
	const { server, ctx, jobManager, viewerPort, options } = params;
	const s = options.metrics
		? wrapServerWithMetrics(server, {
				metrics: options.metrics,
				logger: options.logger,
				metricName: METRIC.MC_MCP_TOOL_CALLS,
			})
		: server;
	registerObserveStateTool(s, ctx, jobManager);
	registerRecoverStateTool(s, ctx, jobManager, options.stuckRecovery);
	registerRecentEventsTool(s, ctx);
	registerActionTools(s, () => ctx.getBot(), jobManager, options.logger);
	registerJobStatusTool(s, jobManager);
	registerViewerUrlTool(s, ctx, viewerPort);
}
