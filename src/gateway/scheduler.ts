import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import type { DueReminder, HeartbeatConfig, Logger, MemoryConsolidator, MetricsCollector } from "../core/types.ts";
import { DEFAULT_HEARTBEAT_CONFIG } from "../core/types.ts";
import { evaluateDueReminders, withTimeout } from "../core/functions.ts";
import { METRIC } from "../observability/metrics.ts";
import type { AiAgent } from "../agent/router.ts";

// ─── HeartbeatConfigRepository (local) ──────────────────────────

interface HeartbeatConfigRepository {
	load(): Promise<HeartbeatConfig>;
	save(config: HeartbeatConfig): Promise<void>;
}

class JsonHeartbeatConfigRepository implements HeartbeatConfigRepository {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = resolve(filePath);
	}

	load(): Promise<HeartbeatConfig> {
		if (!existsSync(this.filePath)) {
			return Promise.resolve(structuredClone(DEFAULT_HEARTBEAT_CONFIG));
		}
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			return Promise.resolve(JSON.parse(raw) as HeartbeatConfig);
		} catch {
			return Promise.resolve(structuredClone(DEFAULT_HEARTBEAT_CONFIG));
		}
	}

	async save(config: HeartbeatConfig): Promise<void> {
		this.ensureDir();
		await Bun.write(this.filePath, JSON.stringify(config, null, 2));
	}

	private ensureDir(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}

// ─── Heartbeat prompt builder ───────────────────────────────────

const HEARTBEAT_SESSION_PREFIX = "system:heartbeat:";

function buildHeartbeatPrompt(dueReminders: DueReminder[]): string {
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

function groupByGuild(dueReminders: DueReminder[]): Map<string, DueReminder[]> {
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
	private readonly configRepo: HeartbeatConfigRepository;

	constructor(
		private readonly agent: AiAgent,
		private readonly logger: Logger,
		private readonly metrics: MetricsCollector | undefined,
		root: string,
	) {
		this.configRepo = new JsonHeartbeatConfigRepository(
			resolve(root, "data/heartbeat-config.json"),
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
		try {
			await withTimeout(this.executeTick(), HEARTBEAT_TICK_TIMEOUT_MS, "heartbeat tick timed out");
			this.metrics?.incrementCounter(METRIC.HEARTBEAT_TICKS, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(METRIC.HEARTBEAT_TICKS, { outcome: "error" });
			this.logger.error("[heartbeat] tick エラー:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(METRIC.HEARTBEAT_TICK_DURATION, duration);
			this.running = false;
		}
	}

	private async executeTick(): Promise<void> {
		const config = await this.configRepo.load();
		const dueReminders = evaluateDueReminders(config, new Date());

		if (dueReminders.length === 0) return;

		this.logger.info(
			`[heartbeat] ${String(dueReminders.length)} 件の due リマインダー: ${dueReminders.map((d) => d.reminder.id).join(", ")}`,
		);

		await this.executeHeartbeat(dueReminders);
		this.metrics?.incrementCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED);
	}

	/** Inlined HandleHeartbeatUseCase.execute */
	private async executeHeartbeat(dueReminders: DueReminder[]): Promise<void> {
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

		const config = await this.configRepo.load();
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

// ─── ConsolidationScheduler ─────────────────────────────────────

/** 30 minutes */
const CONSOLIDATION_TICK_INTERVAL_MS = 30 * 60_000;
/** 10 minutes (LLM calls are slow) */
const CONSOLIDATION_TICK_TIMEOUT_MS = 10 * 60_000;
/** 5 minutes delay before first tick */
const CONSOLIDATION_INITIAL_DELAY_MS = 5 * 60_000;

export class ConsolidationScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private initialTimer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private executePromise: Promise<void> | null = null;

	constructor(
		private readonly consolidator: MemoryConsolidator,
		private readonly logger: Logger,
		private readonly metrics?: MetricsCollector,
	) {}

	start(): void {
		if (this.timer || this.initialTimer) return;
		this.logger.info("[ltm-consolidation] スケジューラ開始（30分間隔、初回5分後）");
		this.initialTimer = setTimeout(() => {
			this.initialTimer = null;
			void this.tick();
			this.timer = setInterval(() => void this.tick(), CONSOLIDATION_TICK_INTERVAL_MS);
		}, CONSOLIDATION_INITIAL_DELAY_MS);
	}

	stop(): void {
		if (this.initialTimer) {
			clearTimeout(this.initialTimer);
			this.initialTimer = null;
		}
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.logger.info("[ltm-consolidation] スケジューラ停止");
	}

	private async tick(): Promise<void> {
		if (this.running) {
			this.logger.info("[ltm-consolidation] 前回の実行がまだ進行中、スキップ");
			return;
		}

		this.running = true;
		const start = performance.now();
		const execution = this.executeConsolidation();
		this.executePromise = execution;
		try {
			await withTimeout(
				execution,
				CONSOLIDATION_TICK_TIMEOUT_MS,
				"ltm consolidation tick timed out",
			);
			this.metrics?.incrementCounter(METRIC.LTM_CONSOLIDATION_TICKS, { outcome: "success" });
		} catch (error) {
			this.metrics?.incrementCounter(METRIC.LTM_CONSOLIDATION_TICKS, { outcome: "error" });
			this.logger.error("[ltm-consolidation] tick エラー:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics?.observeHistogram(METRIC.LTM_CONSOLIDATION_TICK_DURATION, duration);
		}

		// タイムアウト後も内部処理が完了するまで running を保持し、次の tick との並走を防ぐ
		await execution.catch(() => {});
		this.executePromise = null;
		this.running = false;
	}

	/** Inlined ConsolidateMemoryUseCase.execute */
	private async executeConsolidation(): Promise<void> {
		const guildIds = this.consolidator.getActiveGuildIds();
		if (guildIds.length === 0) {
			this.logger.info("[ltm-consolidation] アクティブなギルドなし、スキップ");
			return;
		}

		for (const guildId of guildIds) {
			try {
				/* oxlint-disable-next-line no-await-in-loop -- sequential: avoid DB write contention across guilds */
				const result = await this.consolidator.consolidate(guildId);
				if (result.processedEpisodes > 0) {
					this.logger.info(
						`[ltm-consolidation] guild=${guildId}: ${String(result.processedEpisodes)} episodes processed, new=${String(result.newFacts)} reinforce=${String(result.reinforced)} update=${String(result.updated)} invalidate=${String(result.invalidated)}`,
					);
				}
			} catch (err) {
				this.logger.error(`[ltm-consolidation] guild=${guildId} failed:`, err);
			}
		}
	}
}
