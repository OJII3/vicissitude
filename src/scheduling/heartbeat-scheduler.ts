import { resolve } from "path";

import { HEARTBEAT_CONFIG_RELATIVE_PATH } from "../core/config.ts";
import { evaluateDueReminders, withTimeout } from "../core/functions.ts";
import type {
	AiAgent,
	DueReminder,
	HeartbeatConfig,
	Logger,
	MetricsCollector,
} from "../core/types.ts";
import { METRIC } from "../observability/metrics.ts";
import { JsonHeartbeatConfigRepository } from "./heartbeat-config.ts";

function delayResolve<T>(ms: number, value: T): Promise<T> {
	return new Promise((_resolve) => {
		setTimeout(() => _resolve(value), ms);
	});
}

// ─── Heartbeat prompt builder ───────────────────────────────────

const HEARTBEAT_SESSION_PREFIX = "system:heartbeat:";

export function buildHeartbeatPrompt(dueReminders: DueReminder[]): string {
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

export function groupByGuild(dueReminders: DueReminder[]): Map<string, DueReminder[]> {
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

// ─── HeartbeatScheduler ─────────────────────────────────────────

const HEARTBEAT_TICK_INTERVAL_MS = 60_000;
const HEARTBEAT_TICK_TIMEOUT_MS = 180_000;

export class HeartbeatScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly configRepo: JsonHeartbeatConfigRepository;

	constructor(
		private readonly agent: AiAgent,
		private readonly logger: Logger,
		private readonly metrics: MetricsCollector | undefined,
		root: string,
	) {
		this.configRepo = new JsonHeartbeatConfigRepository(
			resolve(root, HEARTBEAT_CONFIG_RELATIVE_PATH),
		);
	}

	start(): void {
		if (this.timer) return;
		this.logger.info("[heartbeat] スケジューラ開始（1分間隔）");
		void this.tick();
		this.timer = setInterval(() => void this.tick(), HEARTBEAT_TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.logger.info("[heartbeat] スケジューラ停止");
	}

	private async tick(): Promise<void> {
		if (this.running) {
			this.logger.info("[heartbeat] 前回の実行がまだ進行中、スキップ");
			return;
		}

		this.running = true;
		const start = performance.now();
		const execution = this.executeTick();
		try {
			await withTimeout(execution, HEARTBEAT_TICK_TIMEOUT_MS, "heartbeat tick timed out");
			this.metrics?.incrementCounter(METRIC.HEARTBEAT_TICKS, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(METRIC.HEARTBEAT_TICKS, { outcome: "error" });
			this.logger.error("[heartbeat] tick エラー:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(METRIC.HEARTBEAT_TICK_DURATION, duration);
		}

		// Wait for execution to complete, but cap at double the timeout to prevent deadlock
		const settled = await Promise.race([
			execution.then(() => true).catch(() => true),
			delayResolve(HEARTBEAT_TICK_TIMEOUT_MS, false as const),
		]);
		if (!settled) {
			this.logger.error(
				"[heartbeat] execution did not settle after force timeout, resetting running flag",
			);
		}
		this.running = false;
	}

	private async executeTick(): Promise<void> {
		const config = await this.configRepo.load();
		const dueReminders = evaluateDueReminders(config, new Date());

		if (dueReminders.length === 0) return;

		this.logger.info(
			`[heartbeat] ${String(dueReminders.length)} 件の due リマインダー: ${dueReminders.map((d) => d.reminder.id).join(", ")}`,
		);

		await this.executeHeartbeat(config, dueReminders);
		this.metrics?.incrementCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED);
	}

	/** Inlined HandleHeartbeatUseCase.execute */
	private async executeHeartbeat(
		config: HeartbeatConfig,
		dueReminders: DueReminder[],
	): Promise<void> {
		const grouped = groupByGuild(dueReminders);
		const succeededIds = new Set<string>();

		for (const [guildKey, reminders] of grouped) {
			const guildId = guildKey === "_autonomous" ? undefined : guildKey;
			const sessionKey = `${HEARTBEAT_SESSION_PREFIX}${guildKey}`;
			const prompt = buildHeartbeatPrompt(reminders);
			this.logger.info(
				`[heartbeat] guild=${guildKey}: ${reminders.length} 件の due リマインダーを実行`,
			);

			try {
				// oxlint-disable-next-line no-await-in-loop -- Guild ごとに逐次実行する設計
				await this.agent.send({ sessionKey, message: prompt, guildId });
				for (const r of reminders) succeededIds.add(r.reminder.id);
			} catch (error) {
				this.logger.error(`[heartbeat] guild=${guildKey} AI 実行エラー:`, error);
			}
		}

		if (succeededIds.size === 0) {
			this.logger.info("[heartbeat] 成功した Guild なし、config 更新をスキップ");
			return;
		}

		const executedAt = new Date().toISOString();
		for (const reminder of config.reminders) {
			if (succeededIds.has(reminder.id)) {
				reminder.lastExecutedAt = executedAt;
			}
		}
		await this.configRepo.save(config);
		this.logger.info("[heartbeat] 完了");
	}
}
