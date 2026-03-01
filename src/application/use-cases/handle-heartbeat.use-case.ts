import type { DueReminder } from "../../domain/entities/heartbeat-config.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { HeartbeatConfigRepository } from "../../domain/ports/heartbeat-config-repository.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";

const HEARTBEAT_SESSION_PREFIX = "system:heartbeat:";

export class HandleHeartbeatUseCase {
	constructor(
		private readonly agent: AiAgent,
		private readonly configRepo: HeartbeatConfigRepository,
		private readonly logger: Logger,
	) {}

	async execute(dueReminders: DueReminder[]): Promise<void> {
		const grouped = this.groupByGuild(dueReminders);

		for (const [guildKey, reminders] of grouped) {
			const guildId = guildKey === "_autonomous" ? undefined : guildKey;
			const sessionKey = `${HEARTBEAT_SESSION_PREFIX}${guildKey}`;
			const prompt = this.buildPrompt(reminders);
			this.logger.info(
				`[heartbeat] guild=${guildKey}: ${reminders.length} 件の due リマインダーを実行`,
			);

			try {
				// oxlint-disable-next-line no-await-in-loop -- Guild ごとに逐次実行する設計
				await this.agent.send({ sessionKey, message: prompt, guildId });
			} catch (error) {
				this.logger.error(`[heartbeat] guild=${guildKey} AI 実行エラー:`, error);
			}
		}

		const config = await this.configRepo.load();
		const executedAt = new Date().toISOString();
		const dueIds = new Set(dueReminders.map((d) => d.reminder.id));
		for (const reminder of config.reminders) {
			if (dueIds.has(reminder.id)) {
				reminder.lastExecutedAt = executedAt;
			}
		}
		await this.configRepo.save(config);

		this.logger.info("[heartbeat] 完了");
	}

	private groupByGuild(dueReminders: DueReminder[]): Map<string, DueReminder[]> {
		const groups = new Map<string, DueReminder[]>();
		for (const due of dueReminders) {
			const key = due.reminder.guildId ?? "_autonomous";
			const group = groups.get(key);
			if (group) {
				group.push(due);
			} else {
				groups.set(key, [due]);
			}
		}
		return groups;
	}

	buildPrompt(dueReminders: DueReminder[]): string {
		const now = new Date();
		const datetime = now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

		const reminderLines = dueReminders
			.map((due) => {
				const schedule = due.reminder.schedule;
				const scheduleLabel =
					schedule.type === "interval"
						? `${String(schedule.minutes)}分ごと`
						: `毎日 ${String(schedule.hour)}:${String(schedule.minute).padStart(2, "0")}`;
				const lastLabel = due.reminder.lastExecutedAt ?? "なし";
				return `- [${scheduleLabel}] ${due.reminder.description}（最後: ${lastLabel}）`;
			})
			.join("\n");

		return `[heartbeat] 今は ${datetime} だよ。

## やることメモ
${reminderLines}

好きにしていいよ。何かしたいことがあれば MCP ツールを使って。
スケジュールを変えたいなら schedule ツールで。
特になければ何もしなくていいよ。`;
	}
}
