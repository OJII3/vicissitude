import { heartbeatSessionKey } from "@vicissitude/shared/namespace";
import type { AiAgent, DueReminder, Logger } from "@vicissitude/shared/types";

export function buildHeartbeatPrompt(dueReminders: DueReminder[]): string {
	const now = new Date();
	const datetime = now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

	const reminderLines = dueReminders
		.map((due) => {
			const schedule = due.reminder.schedule;
			const scheduleLabel =
				schedule.type === "interval"
					? `every ${String(schedule.minutes)}min`
					: `daily ${String(schedule.hour)}:${String(schedule.minute).padStart(2, "0")}`;
			const lastLabel = due.reminder.lastExecutedAt ?? "never";
			let line = `- [${scheduleLabel}] ${due.reminder.description}（最後: ${lastLabel}）`;
			if (due.context) {
				line += `\n  ${due.context}`;
			}
			return line;
		})
		.join("\n");

	return `[heartbeat] 今は ${datetime} だよ。

## やることメモ
${reminderLines}

好きにしていいよ。何かしたいことがあれば MCP ツールを使って。
スケジュールを変えたいなら schedule ツールで。
特になければ何もしなくていいよ。`;
}

export function groupByScope(dueReminders: DueReminder[]): Map<string, DueReminder[]> {
	const groups = new Map<string, DueReminder[]>();
	for (const due of dueReminders) {
		const key = due.reminder.scopeId ?? "_autonomous";
		const group = groups.get(key);
		if (group) {
			group.push(due);
		} else {
			groups.set(key, [due]);
		}
	}
	return groups;
}

export interface HeartbeatServiceDeps {
	agent: AiAgent;
	logger: Logger;
}

export class HeartbeatService {
	constructor(private readonly deps: HeartbeatServiceDeps) {}

	async execute(dueReminders: DueReminder[]): Promise<Set<string>> {
		const grouped = groupByScope(dueReminders);
		const succeededIds = new Set<string>();
		const results = await Promise.all(
			[...grouped.entries()].map(async ([scopeKey, reminders]) => {
				const scopeId = scopeKey === "_autonomous" ? undefined : scopeKey;
				const sessionKey = heartbeatSessionKey(scopeKey);
				const prompt = buildHeartbeatPrompt(reminders);
				this.deps.logger.info(
					`[heartbeat] scope=${scopeKey}: executing ${reminders.length} due reminder(s)`,
				);

				try {
					await this.deps.agent.send({ sessionKey, message: prompt, scopeId });
					return reminders.map((reminder) => reminder.reminder.id);
				} catch (error) {
					this.deps.logger.error(`[heartbeat] scope=${scopeKey} AI execution error:`, error);
					return [];
				}
			}),
		);

		for (const ids of results) {
			for (const id of ids) {
				succeededIds.add(id);
			}
		}

		return succeededIds;
	}
}
