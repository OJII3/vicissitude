import { mock } from "bun:test";

import type { Logger, MetricsCollector } from "@vicissitude/shared/types";

export function createMockLogger(): Logger {
	return {
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
	};
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
