export type ReminderSchedule =
	| { type: "interval"; minutes: number }
	| { type: "daily"; hour: number; minute: number };

export interface HeartbeatReminder {
	id: string;
	description: string;
	schedule: ReminderSchedule;
	lastExecutedAt: string | null;
	enabled: boolean;
}

export interface HeartbeatConfig {
	baseIntervalMinutes: number;
	reminders: HeartbeatReminder[];
}

export interface DueReminder {
	reminder: HeartbeatReminder;
	overdueMinutes: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
	baseIntervalMinutes: 1,
	reminders: [
		{
			id: "home-check",
			description: "ホームチャンネルの様子を見る",
			schedule: { type: "interval", minutes: 30 },
			lastExecutedAt: null,
			enabled: true,
		},
		{
			id: "memory-update",
			description:
				"memory MCP ツールを使ってメモリを更新する。手順: daily log → MEMORY.md → LESSONS.md → SOUL.md の順で確認・更新",
			schedule: { type: "interval", minutes: 60 },
			lastExecutedAt: null,
			enabled: true,
		},
	],
};
