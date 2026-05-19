/* oxlint-disable max-lines -- schedule tools register 5 MCP tools in one module */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_SCOPE_ID_RE } from "@vicissitude/shared/namespace";
import type { HeartbeatConfigPort } from "@vicissitude/shared/ports";
import type { HeartbeatReminder } from "@vicissitude/shared/types";
import { z } from "zod";

const scopeIdSchema = z.string().regex(AGENT_SCOPE_ID_RE).describe("Agent scope ID");

export function filterRemindersByScope(
	reminders: HeartbeatReminder[],
	scopeId: string,
): HeartbeatReminder[] {
	return reminders.filter((r) => checkScope(r, scopeId));
}

export function checkScope(reminder: HeartbeatReminder, scopeId: string): boolean {
	return reminder.scopeId === scopeId || reminder.scopeId === undefined;
}

function registerReadTools(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundScopeId?: string,
): void {
	server.registerTool(
		"get_heartbeat_config",
		{ description: "Show current heartbeat configuration" },
		async () => {
			const config = await configPort.load();
			return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }] };
		},
	);

	server.registerTool(
		"list_reminders",
		{
			description: "List reminders (current scope + global only)",
			inputSchema: boundScopeId ? {} : { scope_id: scopeIdSchema },
		},
		async ({ scope_id }: { scope_id?: string }) => {
			const scopeId = boundScopeId ?? scope_id;
			if (!scopeId) {
				return { content: [{ type: "text" as const, text: "Error: scope_id is required" }] };
			}
			const config = await configPort.load();
			const visible = filterRemindersByScope(config.reminders, scopeId);
			const lines = visible.map((r) => {
				const schedule =
					r.schedule.type === "interval"
						? `every ${String(r.schedule.minutes)}min`
						: `daily ${String(r.schedule.hour)}:${String(r.schedule.minute).padStart(2, "0")}`;
				const status = r.enabled ? "enabled" : "disabled";
				const last = r.lastExecutedAt ?? "never";
				const scope = r.scopeId ? `scope:${r.scopeId}` : "global";
				return `- [${r.id}] ${r.description} (${schedule}, ${status}, ${scope}, last: ${last})`;
			});
			return { content: [{ type: "text" as const, text: lines.join("\n") || "No reminders" }] };
		},
	);

	server.registerTool(
		"set_base_interval",
		{
			description: "Set base check interval (minutes)",
			inputSchema: { minutes: z.number().min(1).describe("Check interval in minutes") },
		},
		async ({ minutes }) => {
			const config = await configPort.load();
			config.baseIntervalMinutes = minutes;
			await configPort.save(config);
			return {
				content: [
					{
						type: "text",
						text: `Base interval set to ${String(minutes)} minutes`,
					},
				],
			};
		},
	);
}

function registerAddReminder(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundScopeId?: string,
): void {
	server.registerTool(
		"add_reminder",
		{
			description: "Add a new reminder (defaults to current scope)",
			inputSchema: {
				...(boundScopeId ? {} : { scope_id: scopeIdSchema }),
				id: z.string().describe("Unique identifier"),
				description: z.string().describe("Reminder description"),
				schedule_type: z.enum(["interval", "daily"]).describe("Schedule type"),
				interval_minutes: z
					.number()
					.min(1)
					.optional()
					.describe("Minutes for interval type (min 1)"),
				daily_hour: z.number().min(0).max(23).optional().describe("Hour for daily type"),
				daily_minute: z.number().min(0).max(59).optional().describe("Minute for daily type"),
				global: z
					.boolean()
					.optional()
					.describe("Set true for a global reminder not bound to any scope (default: false)"),
			},
		},
		async ({
			scope_id,
			id,
			description,
			schedule_type,
			interval_minutes,
			daily_hour,
			daily_minute,
			global: isGlobal,
		}: {
			scope_id?: string;
			id: string;
			description: string;
			schedule_type: "interval" | "daily";
			interval_minutes?: number;
			daily_hour?: number;
			daily_minute?: number;
			global?: boolean;
		}) => {
			const resolvedScopeId = boundScopeId ?? scope_id;
			if (!resolvedScopeId) {
				return { content: [{ type: "text" as const, text: "Error: scope_id is required" }] };
			}
			const config = await configPort.load();

			if (config.reminders.some((r) => r.id === id)) {
				return {
					content: [{ type: "text" as const, text: `Error: ID "${id}" already exists` }],
				};
			}

			const scopeId = isGlobal ? undefined : resolvedScopeId;

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
					scopeId,
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
					scopeId,
				};
			}

			config.reminders.push(reminder);
			await configPort.save(config);
			return {
				content: [{ type: "text" as const, text: `Reminder "${id}" added` }],
			};
		},
	);
}

function registerModifyReminders(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundScopeId?: string,
): void {
	server.registerTool(
		"update_reminder",
		{
			description: "Update a reminder (own scope or global only)",
			inputSchema: {
				...(boundScopeId ? {} : { scope_id: scopeIdSchema }),
				id: z.string().describe("ID of the reminder to update"),
				description: z.string().optional().describe("New description"),
				enabled: z.boolean().optional().describe("Enable/disable"),
				schedule_type: z.enum(["interval", "daily"]).optional().describe("New schedule type"),
				interval_minutes: z
					.number()
					.min(1)
					.optional()
					.describe("Minutes for interval type (min 1)"),
				daily_hour: z.number().min(0).max(23).optional().describe("Hour for daily type"),
				daily_minute: z.number().min(0).max(59).optional().describe("Minute for daily type"),
			},
		},
		async ({
			scope_id,
			id,
			description,
			enabled,
			schedule_type,
			interval_minutes,
			daily_hour,
			daily_minute,
		}: {
			scope_id?: string;
			id: string;
			description?: string;
			enabled?: boolean;
			schedule_type?: "interval" | "daily";
			interval_minutes?: number;
			daily_hour?: number;
			daily_minute?: number;
		}) => {
			const scopeId = boundScopeId ?? scope_id;
			if (!scopeId) {
				return { content: [{ type: "text" as const, text: "Error: scope_id is required" }] };
			}
			const config = await configPort.load();
			const reminder = config.reminders.find((r) => r.id === id);

			if (!reminder) {
				return {
					content: [{ type: "text" as const, text: `Error: ID "${id}" not found` }],
				};
			}

			if (!checkScope(reminder, scopeId)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: reminder "${id}" belongs to another scope and cannot be updated`,
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
				content: [{ type: "text" as const, text: `Reminder "${id}" updated` }],
			};
		},
	);

	server.registerTool(
		"remove_reminder",
		{
			description: "Remove a reminder (own scope or global only)",
			inputSchema: {
				...(boundScopeId ? {} : { scope_id: scopeIdSchema }),
				id: z.string().describe("ID of the reminder to remove"),
			},
		},
		async ({ scope_id, id }: { scope_id?: string; id: string }) => {
			const scopeId = boundScopeId ?? scope_id;
			if (!scopeId) {
				return { content: [{ type: "text" as const, text: "Error: scope_id is required" }] };
			}
			const config = await configPort.load();
			const reminder = config.reminders.find((r) => r.id === id);

			if (!reminder) {
				return {
					content: [{ type: "text" as const, text: `Error: ID "${id}" not found` }],
				};
			}

			if (!checkScope(reminder, scopeId)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: reminder "${id}" belongs to another scope and cannot be removed`,
						},
					],
				};
			}

			config.reminders.splice(config.reminders.indexOf(reminder), 1);
			await configPort.save(config);
			return {
				content: [{ type: "text" as const, text: `Reminder "${id}" removed` }],
			};
		},
	);
}

export function registerScheduleTools(
	server: McpServer,
	configPort: HeartbeatConfigPort,
	boundScopeId?: string,
): void {
	registerReadTools(server, configPort, boundScopeId);
	registerAddReminder(server, configPort, boundScopeId);
	registerModifyReminders(server, configPort, boundScopeId);
}
