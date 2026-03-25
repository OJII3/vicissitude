import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APP_ROOT, HEARTBEAT_CONFIG_RELATIVE_PATH } from "@vicissitude/shared/config";
import { createDefaultHeartbeatConfig } from "@vicissitude/shared/functions";
import type { HeartbeatConfig, HeartbeatReminder } from "@vicissitude/shared/types";
import { z } from "zod";

const GUILD_ID_REGEX = /^\d+$/;
const guildIdSchema = z.string().regex(GUILD_ID_REGEX).describe("Discord guild ID");

export function filterRemindersByGuild(
	reminders: HeartbeatReminder[],
	guildId: string,
): HeartbeatReminder[] {
	return reminders.filter((r) => checkGuildScope(r, guildId));
}

export function checkGuildScope(reminder: HeartbeatReminder, guildId: string): boolean {
	return reminder.guildId === guildId || reminder.guildId === undefined;
}

const DATA_DIR = process.env.DATA_DIR;
const CONFIG_PATH = DATA_DIR
	? resolve(DATA_DIR, "heartbeat-config.json")
	: resolve(APP_ROOT, HEARTBEAT_CONFIG_RELATIVE_PATH);

function loadConfig(): HeartbeatConfig {
	if (!existsSync(CONFIG_PATH)) return createDefaultHeartbeatConfig();
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as HeartbeatConfig;
	} catch {
		return createDefaultHeartbeatConfig();
	}
}

async function saveConfig(config: HeartbeatConfig): Promise<void> {
	const dir = dirname(CONFIG_PATH);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function registerScheduleTools(server: McpServer, boundGuildId?: string): void {
	server.registerTool(
		"get_heartbeat_config",
		{ description: "現在の heartbeat 設定を表示する" },
		() => {
			const config = loadConfig();
			return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
		},
	);

	server.registerTool(
		"list_reminders",
		{
			description: "リマインダー一覧を表示する（現在のギルド＋グローバルのみ）",
			inputSchema: boundGuildId ? {} : { guild_id: guildIdSchema },
		},
		({ guild_id }: { guild_id?: string }) => {
			const gid = boundGuildId ?? guild_id;
			if (!gid) {
				return { content: [{ type: "text" as const, text: "エラー: guild_id が必要です" }] };
			}
			const config = loadConfig();
			const visible = filterRemindersByGuild(config.reminders, gid);
			const lines = visible.map((r) => {
				const schedule =
					r.schedule.type === "interval"
						? `${String(r.schedule.minutes)}分ごと`
						: `毎日 ${String(r.schedule.hour)}:${String(r.schedule.minute).padStart(2, "0")}`;
				const status = r.enabled ? "有効" : "無効";
				const last = r.lastExecutedAt ?? "未実行";
				const scope = r.guildId ? `guild:${r.guildId}` : "global";
				return `- [${r.id}] ${r.description} (${schedule}, ${status}, ${scope}, 最後: ${last})`;
			});
			return { content: [{ type: "text" as const, text: lines.join("\n") || "リマインダーなし" }] };
		},
	);

	server.registerTool(
		"add_reminder",
		{
			description: "新しいリマインダーを追加する（デフォルトで現在のギルドに紐づく）",
			inputSchema: {
				...(boundGuildId ? {} : { guild_id: guildIdSchema }),
				id: z.string().describe("一意の識別子"),
				description: z.string().describe("リマインダーの説明"),
				schedule_type: z.enum(["interval", "daily"]).describe("スケジュールタイプ"),
				interval_minutes: z.number().min(1).optional().describe("interval の場合の分数（1以上）"),
				daily_hour: z.number().min(0).max(23).optional().describe("daily の場合の時"),
				daily_minute: z.number().min(0).max(59).optional().describe("daily の場合の分"),
				global: z
					.boolean()
					.optional()
					.describe(
						"true にするとギルドに紐づかないグローバルリマインダーになる（デフォルト: false）",
					),
			},
		},
		async ({
			guild_id,
			id,
			description,
			schedule_type,
			interval_minutes,
			daily_hour,
			daily_minute,
			global: isGlobal,
		}: {
			guild_id?: string;
			id: string;
			description: string;
			schedule_type: "interval" | "daily";
			interval_minutes?: number;
			daily_hour?: number;
			daily_minute?: number;
			global?: boolean;
		}) => {
			const resolvedGuildId = boundGuildId ?? guild_id;
			if (!resolvedGuildId) {
				return { content: [{ type: "text" as const, text: "エラー: guild_id が必要です" }] };
			}
			const config = loadConfig();

			if (config.reminders.some((r) => r.id === id)) {
				return {
					content: [{ type: "text" as const, text: `エラー: ID "${id}" は既に存在します` }],
				};
			}

			const guildId = isGlobal ? undefined : resolvedGuildId;

			let reminder: HeartbeatReminder;
			if (schedule_type === "interval") {
				if (interval_minutes === undefined) {
					return {
						content: [{ type: "text" as const, text: "エラー: interval_minutes が必要です" }],
					};
				}
				reminder = {
					id,
					description,
					schedule: { type: "interval", minutes: interval_minutes },
					lastExecutedAt: null,
					enabled: true,
					guildId,
				};
			} else {
				reminder = {
					id,
					description,
					schedule: {
						type: "daily",
						hour: daily_hour ?? 9,
						minute: daily_minute ?? 0,
					},
					lastExecutedAt: null,
					enabled: true,
					guildId,
				};
			}

			config.reminders.push(reminder);
			await saveConfig(config);
			return {
				content: [{ type: "text" as const, text: `リマインダー "${id}" を追加しました` }],
			};
		},
	);

	server.registerTool(
		"update_reminder",
		{
			description: "リマインダーを更新する（自ギルドまたはグローバルのみ）",
			inputSchema: {
				...(boundGuildId ? {} : { guild_id: guildIdSchema }),
				id: z.string().describe("更新するリマインダーの ID"),
				description: z.string().optional().describe("新しい説明"),
				enabled: z.boolean().optional().describe("有効/無効"),
				schedule_type: z
					.enum(["interval", "daily"])
					.optional()
					.describe("新しいスケジュールタイプ"),
				interval_minutes: z.number().min(1).optional().describe("interval の場合の分数（1以上）"),
				daily_hour: z.number().min(0).max(23).optional().describe("daily の場合の時"),
				daily_minute: z.number().min(0).max(59).optional().describe("daily の場合の分"),
			},
		},
		async ({
			guild_id,
			id,
			description,
			enabled,
			schedule_type,
			interval_minutes,
			daily_hour,
			daily_minute,
		}: {
			guild_id?: string;
			id: string;
			description?: string;
			enabled?: boolean;
			schedule_type?: "interval" | "daily";
			interval_minutes?: number;
			daily_hour?: number;
			daily_minute?: number;
		}) => {
			const gid = boundGuildId ?? guild_id;
			if (!gid) {
				return { content: [{ type: "text" as const, text: "エラー: guild_id が必要です" }] };
			}
			const config = loadConfig();
			const reminder = config.reminders.find((r) => r.id === id);

			if (!reminder) {
				return {
					content: [{ type: "text" as const, text: `エラー: ID "${id}" が見つかりません` }],
				};
			}

			if (!checkGuildScope(reminder, gid)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `エラー: リマインダー "${id}" は他のギルドに属しているため更新できません`,
						},
					],
				};
			}

			if (description !== undefined) reminder.description = description;
			if (enabled !== undefined) reminder.enabled = enabled;

			if (schedule_type === "interval" && interval_minutes !== undefined) {
				reminder.schedule = { type: "interval", minutes: interval_minutes };
			} else if (schedule_type === "daily") {
				reminder.schedule = {
					type: "daily",
					hour: daily_hour ?? 9,
					minute: daily_minute ?? 0,
				};
			}

			await saveConfig(config);
			return {
				content: [{ type: "text" as const, text: `リマインダー "${id}" を更新しました` }],
			};
		},
	);

	server.registerTool(
		"remove_reminder",
		{
			description: "リマインダーを削除する（自ギルドまたはグローバルのみ）",
			inputSchema: {
				...(boundGuildId ? {} : { guild_id: guildIdSchema }),
				id: z.string().describe("削除するリマインダーの ID"),
			},
		},
		async ({ guild_id, id }: { guild_id?: string; id: string }) => {
			const gid = boundGuildId ?? guild_id;
			if (!gid) {
				return { content: [{ type: "text" as const, text: "エラー: guild_id が必要です" }] };
			}
			const config = loadConfig();
			const reminder = config.reminders.find((r) => r.id === id);

			if (!reminder) {
				return {
					content: [{ type: "text" as const, text: `エラー: ID "${id}" が見つかりません` }],
				};
			}

			if (!checkGuildScope(reminder, gid)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `エラー: リマインダー "${id}" は他のギルドに属しているため削除できません`,
						},
					],
				};
			}

			config.reminders.splice(config.reminders.indexOf(reminder), 1);
			await saveConfig(config);
			return {
				content: [{ type: "text" as const, text: `リマインダー "${id}" を削除しました` }],
			};
		},
	);

	server.registerTool(
		"set_base_interval",
		{
			description: "ベースチェック間隔を変更する（分）",
			inputSchema: { minutes: z.number().min(1).describe("チェック間隔（分）") },
		},
		async ({ minutes }) => {
			const config = loadConfig();
			config.baseIntervalMinutes = minutes;
			await saveConfig(config);
			return {
				content: [
					{
						type: "text",
						text: `ベース間隔を ${String(minutes)} 分に変更しました`,
					},
				],
			};
		},
	);
}
