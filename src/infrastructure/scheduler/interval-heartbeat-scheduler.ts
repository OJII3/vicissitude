import type { HandleHeartbeatUseCase } from "../../application/use-cases/handle-heartbeat.use-case.ts";
import type { HeartbeatConfigRepository } from "../../domain/ports/heartbeat-config-repository.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import { evaluateDueReminders } from "../../domain/services/heartbeat-evaluator.ts";
import { withTimeout } from "../../domain/services/timeout.ts";

const TICK_INTERVAL_MS = 60_000;
const TICK_TIMEOUT_MS = 180_000;

export class IntervalHeartbeatScheduler {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(
		private readonly configRepo: HeartbeatConfigRepository,
		private readonly useCase: HandleHeartbeatUseCase,
		private readonly logger: Logger,
	) {}

	start(): void {
		if (this.timer) return;

		this.logger.info("[heartbeat] スケジューラ開始（1分間隔）");

		void this.tick();
		this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
	}

	private async executeTick(): Promise<void> {
		const config = await this.configRepo.load();
		const dueReminders = evaluateDueReminders(config, new Date());

		if (dueReminders.length > 0) {
			this.logger.info(
				`[heartbeat] ${String(dueReminders.length)} 件の due リマインダー: ${dueReminders.map((d) => d.reminder.id).join(", ")}`,
			);
			await this.useCase.execute(dueReminders);
		}
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
		try {
			await withTimeout(this.executeTick(), TICK_TIMEOUT_MS, "heartbeat tick timed out");
		} catch (error) {
			this.logger.error("[heartbeat] tick エラー:", error);
		} finally {
			this.running = false;
		}
	}
}
