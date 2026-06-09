import { METRIC } from "@vicissitude/observability/metrics";
import { withTimeout } from "@vicissitude/shared/functions";
import type { HeartbeatConfigPort } from "@vicissitude/shared/ports";
import type {
	DueReminder,
	HeartbeatConfig,
	Logger,
	MetricsCollector,
} from "@vicissitude/shared/types";

import { evaluateDueReminders } from "./heartbeat-helpers.ts";

// ─── HeartbeatScheduler ─────────────────────────────────────────

const HEARTBEAT_TICK_INTERVAL_MS = 60_000;
const HEARTBEAT_TICK_TIMEOUT_MS = 180_000;

export interface HeartbeatSchedulerDeps {
	configRepo: HeartbeatConfigPort;
	heartbeatService: { execute(dueReminders: DueReminder[]): Promise<Set<string>> };
	logger: Logger;
	metrics?: MetricsCollector;
	preFilter?: (dueReminders: DueReminder[]) => Promise<DueReminder[]>;
}

export class HeartbeatScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private executePromise: Promise<void> | null = null;
	private tickIntervalMs = HEARTBEAT_TICK_INTERVAL_MS;

	constructor(private readonly deps: HeartbeatSchedulerDeps) {}

	start(): void {
		if (this.timer) return;
		this.deps.logger.info("[heartbeat] scheduler started");
		void this.tick();
		this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.deps.logger.info("[heartbeat] scheduler stopped");
	}

	private async tick(): Promise<void> {
		if (this.running) {
			this.deps.logger.info("[heartbeat] previous tick still running, skipping");
			return;
		}

		this.running = true;
		const start = performance.now();
		const execution = this.executeTick();
		this.executePromise = execution;
		let executionSettled = false;
		void execution.then(
			() => {
				executionSettled = true;
				return null;
			},
			() => {
				executionSettled = true;
				return null;
			},
		);
		try {
			await withTimeout(execution, HEARTBEAT_TICK_TIMEOUT_MS, "heartbeat tick timed out");
			this.deps.metrics?.incrementCounter(METRIC.HEARTBEAT_TICKS, { outcome: "success" });
		} catch (error) {
			this.deps.metrics?.incrementCounter(METRIC.HEARTBEAT_TICKS, { outcome: "error" });
			this.deps.logger.error("[heartbeat] tick error:", error);
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.deps.metrics?.observeHistogram(METRIC.HEARTBEAT_TICK_DURATION, duration);
		}

		if (executionSettled) {
			this.releaseExecution(execution);
			return;
		}

		void this.releaseExecutionWhenSettled(execution);
	}

	private async executeTick(): Promise<void> {
		const config = await this.deps.configRepo.load();
		this.applyBaseInterval(config.baseIntervalMinutes);
		const executed = await this.executeHeartbeat(config);
		if (executed) {
			this.deps.metrics?.incrementCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED);
		}
	}

	private applyBaseInterval(baseIntervalMinutes: number): void {
		const nextIntervalMs = baseIntervalMinutes * 60_000;
		if (nextIntervalMs === this.tickIntervalMs) return;

		this.tickIntervalMs = nextIntervalMs;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
		}
		this.deps.logger.info(
			`[heartbeat] scheduler interval updated (${String(baseIntervalMinutes)}min interval)`,
		);
	}

	private releaseExecution(execution: Promise<void>): void {
		if (this.executePromise !== execution) return;
		this.executePromise = null;
		this.running = false;
	}

	private async releaseExecutionWhenSettled(execution: Promise<void>): Promise<void> {
		await execution.catch(() => {});
		this.releaseExecution(execution);
	}

	private async executeHeartbeat(config: HeartbeatConfig): Promise<boolean> {
		let dueReminders = evaluateDueReminders(config, new Date());
		if (dueReminders.length === 0) return false;

		if (this.deps.preFilter) {
			dueReminders = await this.deps.preFilter(dueReminders);
			if (dueReminders.length === 0) {
				this.deps.logger.info("[heartbeat] all reminders filtered out, skipping execution");
				return false;
			}
		}

		this.deps.logger.info(
			`[heartbeat] ${String(dueReminders.length)} due reminder(s): ${dueReminders.map((d) => d.reminder.id).join(", ")}`,
		);

		const succeededIds = await this.deps.heartbeatService.execute(dueReminders);
		if (succeededIds.size === 0) {
			this.deps.logger.info("[heartbeat] no guilds succeeded, skipping config update");
			return true;
		}

		const executedAt = new Date().toISOString();
		await this.deps.configRepo.markRemindersExecuted([...succeededIds], executedAt);
		this.deps.logger.info("[heartbeat] done");
		return true;
	}
}
