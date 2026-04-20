import { mock } from "bun:test";

import type { Logger, MetricsCollector } from "./types";

export interface MockLogger extends Logger {
	debug: ReturnType<typeof mock>;
	info: ReturnType<typeof mock>;
	error: ReturnType<typeof mock>;
	warn: ReturnType<typeof mock>;
	child: ReturnType<typeof mock>;
	children: MockLogger[];
}

export function createMockLogger(): MockLogger {
	const children: MockLogger[] = [];
	const logger: MockLogger = {
		debug: mock(() => {}),
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
		child: mock((_bindings: Record<string, unknown>) => {
			const child = createMockLogger();
			children.push(child);
			return child;
		}),
		children,
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
