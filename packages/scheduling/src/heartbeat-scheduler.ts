import { resolve } from "path";

import { HeartbeatService } from "@vicissitude/application/heartbeat-service";
import { METRIC } from "@vicissitude/observability/metrics";
import { delayResolve, withTimeout } from "@vicissitude/shared/functions";
import type { AiAgent, HeartbeatConfig, Logger, MetricsCollector } from "@vicissitude/shared/types";

import { JsonHeartbeatConfigRepository } from "./heartbeat-config.ts";
import { HEARTBEAT_CONFIG_RELATIVE_PATH, evaluateDueReminders } from "./heartbeat-helpers.ts";

// ─── HeartbeatScheduler ─────────────────────────────────────────

const HEARTBEAT_TICK_INTERVAL_MS = 60_000;
const HEARTBEAT_TICK_TIMEOUT_MS = 180_000;

export class HeartbeatScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly configRepo: JsonHeartbeatConfigRepository;
	private readonly heartbeatService: HeartbeatService;

	constructor(
		agent: AiAgent,
		private readonly logger: Logger,
		private readonly metrics: MetricsCollector | undefined,
		root: string,
	) {
		this.configRepo = new JsonHeartbeatConfigRepository(
			resolve(root, HEARTBEAT_CONFIG_RELATIVE_PATH),
		);
		this.heartbeatService = new HeartbeatService({ agent, logger });
	}

	start(): void {
		if (this.timer) return;
		this.logger.info("[heartbeat] scheduler started (1min interval)");
		void this.tick();
		this.timer = setInterval(() => void this.tick(), HEARTBEAT_TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.logger.info("[heartbeat] scheduler stopped");
	}

	private async tick(): Promise<void> {
		if (this.running) {
			this.logger.info("[heartbeat] previous tick still running, skipping");
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
			this.logger.error("[heartbeat] tick error:", error);
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
		const executed = await this.executeHeartbeat(config);
		if (executed) {
			this.metrics?.incrementCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED);
		}
	}

	private async executeHeartbeat(config: HeartbeatConfig): Promise<boolean> {
		const dueReminders = evaluateDueReminders(config, new Date());
		if (dueReminders.length === 0) return false;
		this.logger.info(
			`[heartbeat] ${String(dueReminders.length)} due reminder(s): ${dueReminders.map((d) => d.reminder.id).join(", ")}`,
		);

		const succeededIds = await this.heartbeatService.execute(dueReminders);
		if (succeededIds.size === 0) {
			this.logger.info("[heartbeat] no guilds succeeded, skipping config update");
			return true;
		}

		const executedAt = new Date().toISOString();
		for (const reminder of config.reminders) {
			if (succeededIds.has(reminder.id)) {
				reminder.lastExecutedAt = executedAt;
			}
		}
		await this.configRepo.save(config);
		this.logger.info("[heartbeat] done");
		return true;
	}
}
