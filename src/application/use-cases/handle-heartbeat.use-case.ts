import type { DueReminder } from "../../domain/entities/heartbeat-config.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { HeartbeatConfigRepository } from "../../domain/ports/heartbeat-config-repository.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";

const HEARTBEAT_SESSION_KEY = "system:heartbeat:_autonomous";

export class HandleHeartbeatUseCase {
	constructor(
		private readonly agent: AiAgent,
		private readonly configRepo: HeartbeatConfigRepository,
		private readonly logger: Logger,
	) {}

	async execute(dueReminders: DueReminder[]): Promise<void> {
		const prompt = this.buildPrompt(dueReminders);
		this.logger.info(`[heartbeat] ${dueReminders.length} 件の due リマインダーを実行`);

		try {
			await this.agent.send(HEARTBEAT_SESSION_KEY, prompt);

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
		} catch (error) {
			this.logger.error("[heartbeat] AI 実行エラー:", error);
		}
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
