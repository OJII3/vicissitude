import { mock } from "bun:test";

import type { Logger, MetricsCollector } from "./types";

export function createMockLogger(): Logger {
	const logger: Logger = {
		debug: mock(() => {}),
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
		child: mock(() => logger),
	};
	return logger;
}

export function createMockMetrics(): MetricsCollector {
	return {
		incrementCounter: mock(() => {}),
		addCounter: mock(() => {}),
		setGauge: mock(() => {}),
		incrementGauge: mock(() => {}),
		decrementGauge: mock(() => {}),
		observeHistogram: mock(() => {}),
	};
}
