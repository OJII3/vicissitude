/* oxlint-disable max-dependencies -- bootstrap helper naturally requires many imports for DI wiring */
import { resolve } from "path";

import { ConsolidateMemoryUseCase } from "./application/use-cases/consolidate-memory.use-case.ts";
import { HandleHeartbeatUseCase } from "./application/use-cases/handle-heartbeat.use-case.ts";
import type { AiAgent } from "./domain/ports/ai-agent.port.ts";
import type { Logger } from "./domain/ports/logger.port.ts";
import type { MemoryConsolidator } from "./domain/ports/memory-consolidator.port.ts";
import type { MetricsCollector } from "./domain/ports/metrics-collector.port.ts";
import type { SessionRepository } from "./domain/ports/session-repository.port.ts";
import { METRIC } from "./infrastructure/metrics/metric-names.ts";
import { JsonHeartbeatConfigRepository } from "./infrastructure/persistence/json-heartbeat-config-repository.ts";
import { IntervalConsolidationScheduler } from "./infrastructure/scheduler/interval-consolidation-scheduler.ts";
import { IntervalHeartbeatScheduler } from "./infrastructure/scheduler/interval-heartbeat-scheduler.ts";

export function createHeartbeat(
	root: string,
	agent: AiAgent,
	logger: Logger,
	metrics?: MetricsCollector,
): IntervalHeartbeatScheduler {
	const configRepo = new JsonHeartbeatConfigRepository(resolve(root, "data/heartbeat-config.json"));
	const useCase = new HandleHeartbeatUseCase(agent, configRepo, logger);
	return new IntervalHeartbeatScheduler(configRepo, useCase, logger, metrics);
}

export function createConsolidationScheduler(
	consolidator: MemoryConsolidator,
	logger: Logger,
	metrics?: MetricsCollector,
): IntervalConsolidationScheduler {
	const useCase = new ConsolidateMemoryUseCase(consolidator, logger, metrics);
	return new IntervalConsolidationScheduler(useCase, logger, metrics);
}

export function startSessionGauge(
	sessions: SessionRepository,
	metrics: MetricsCollector,
): ReturnType<typeof setInterval> {
	const update = () => metrics.setGauge(METRIC.LLM_ACTIVE_SESSIONS, sessions.count());
	update();
	return setInterval(update, 30_000);
}

export function setupShutdown(
	logger: Logger,
	scheduler: { stop(): void },
	gateway: { stop(): void },
	agent: AiAgent,
	emojiUsageRepo: { flush(): Promise<void> },
	metricsServer?: { stop(): void },
	sessionGaugeTimer?: ReturnType<typeof setInterval>,
	ltmChatAdapter?: { close(): void },
	ltmRecorder?: { close(): void },
	ltmFactReader?: { close(): Promise<void> },
	consolidationScheduler?: { stop(): void },
): void {
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down...");
		if (sessionGaugeTimer) clearInterval(sessionGaugeTimer);
		consolidationScheduler?.stop();
		scheduler.stop();
		gateway.stop();
		agent.stop();
		metricsServer?.stop();
		ltmRecorder?.close();
		ltmChatAdapter?.close();
		void ltmFactReader?.close();
		void emojiUsageRepo.flush().finally(() => setTimeout(() => process.exit(0), 1000));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
