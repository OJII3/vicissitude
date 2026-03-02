export interface MetricsCollector {
	incrementCounter(name: string, labels?: Record<string, string>): void;
	setGauge(name: string, value: number, labels?: Record<string, string>): void;
	observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
	serialize(): string;
}
