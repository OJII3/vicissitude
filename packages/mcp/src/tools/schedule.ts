/* oxlint-disable max-lines -- schedule tools register 5 MCP tools in one module */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GUILD_ID_RE } from "@vicissitude/shared/namespace";
import type { HeartbeatConfigPort } from "@vicissitude/shared/ports";
import type { HeartbeatReminder } from "@vicissitude/shared/types";
import { z } from "zod";

const guildIdSchema = z.string().regex(GUILD_ID_RE).describe("Discord guild ID");

export function filterRemindersByGuild(
	reminders: HeartbeatReminder[],
	guildId: string,
): HeartbeatReminder[] {
	return reminders.filter((r) => checkGuildScope(r, guildId));
}

export function checkGuildScope(reminder: HeartbeatReminder, guildId: string): boolean {
	return reminder.guildId === guildId || reminder.guildId === undefined;
}

function registerReadTools(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundGuildId?: string,
): void {
	server.registerTool(
		"get_heartbeat_config",
		{ description: "現在の heartbeat 設定を表示する" },
		async () => {
			const config = await configPort.load();
			return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
		},
	);

	server.registerTool(
		"list_reminders",
		{
			description: "リマインダー一覧を表示する（現在のギルド＋グローバルのみ）",
			inputSchema: boundGuildId ? {} : { guild_id: guildIdSchema },
		},
		async ({ guild_id }: { guild_id?: string }) => {
			const gid = boundGuildId ?? guild_id;
			if (!gid) {
				return { content: [{ type: "text" as const, text: "Error: guild_id is required" }] };
			}
			const config = await configPort.load();
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
		"set_base_interval",
		{
			description: "ベースチェック間隔を変更する（分）",
			inputSchema: { minutes: z.number().min(1).describe("チェック間隔（分）") },
		},
		async ({ minutes }) => {
			const config = await configPort.load();
			config.baseIntervalMinutes = minutes;
			await configPort.save(config);
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

function registerAddReminder(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundGuildId?: string,
): void {
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
				return { content: [{ type: "text" as const, text: "Error: guild_id is required" }] };
			}
			const config = await configPort.load();

			if (config.reminders.some((r) => r.id === id)) {
				return {
					content: [{ type: "text" as const, text: `Error: ID "${id}" already exists` }],
				};
			}

			const guildId = isGlobal ? undefined : resolvedGuildId;

			let reminder: HeartbeatReminder;
			if (schedule_type === "interval") {
				if (interval_minutes === undefined) {
					return {
						content: [{ type: "text" as const, text: "Error: interval_minutes is required" }],
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
			await configPort.save(config);
			return {
				content: [{ type: "text" as const, text: `リマインダー "${id}" を追加しました` }],
			};
		},
	);
}

function registerModifyReminders(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundGuildId?: string,
): void {
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
				return { content: [{ type: "text" as const, text: "Error: guild_id is required" }] };
			}
			const config = await configPort.load();
			const reminder = config.reminders.find((r) => r.id === id);

			if (!reminder) {
				return {
					content: [{ type: "text" as const, text: `Error: ID "${id}" not found` }],
				};
			}

			if (!checkGuildScope(reminder, gid)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: reminder "${id}" belongs to another guild and cannot be updated`,
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

			await configPort.save(config);
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
				return { content: [{ type: "text" as const, text: "Error: guild_id is required" }] };
			}
			const config = await configPort.load();
			const reminder = config.reminders.find((r) => r.id === id);

			if (!reminder) {
				return {
					content: [{ type: "text" as const, text: `Error: ID "${id}" not found` }],
				};
			}

			if (!checkGuildScope(reminder, gid)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: reminder "${id}" belongs to another guild and cannot be removed`,
						},
					],
				};
			}

			config.reminders.splice(config.reminders.indexOf(reminder), 1);
			await configPort.save(config);
			return {
				content: [{ type: "text" as const, text: `リマインダー "${id}" を削除しました` }],
			};
		},
	);
}

export function registerScheduleTools(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundGuildId?: string,
): void {
	registerReadTools(server, configPort, boundGuildId);
	registerAddReminder(server, configPort, boundGuildId);
	registerModifyReminders(server, configPort, boundGuildId);
}
