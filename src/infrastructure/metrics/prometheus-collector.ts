import type { MetricsCollector } from "../../domain/ports/metrics-collector.port.ts";

interface MetricMeta {
	type: "counter" | "gauge" | "histogram";
	help: string;
}

interface HistogramConfig {
	buckets: number[];
}

const DEFAULT_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

function labelsToKey(labels: Record<string, string>): string {
	const entries = Object.entries(labels).toSorted(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "";
	return `{${entries.map(([k, v]) => `${k}="${v}"`).join(",")}}`;
}

function mergeLabels(
	base: Record<string, string> | undefined,
	extra: Record<string, string>,
): Record<string, string> {
	return base && Object.keys(base).length > 0 ? { ...base, ...extra } : extra;
}

function parseLabelsFromKey(key: string): Record<string, string> {
	const labels: Record<string, string> = {};
	if (key.length === 0) return labels;
	const inner = key.slice(1, -1);
	for (const pair of inner.split(",")) {
		const eq = pair.indexOf("=");
		if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 2, -1);
	}
	return labels;
}

export class PrometheusCollector implements MetricsCollector {
	private counters = new Map<string, Map<string, number>>();
	private gauges = new Map<string, Map<string, number>>();
	private histograms = new Map<
		string,
		Map<string, { buckets: Map<number, number>; sum: number; count: number }>
	>();
	private histogramConfigs = new Map<string, HistogramConfig>();
	private metricMeta = new Map<string, MetricMeta>();

	registerCounter(name: string, help: string): void {
		this.metricMeta.set(name, { type: "counter", help });
		if (!this.counters.has(name)) {
			this.counters.set(name, new Map());
		}
	}

	registerGauge(name: string, help: string): void {
		this.metricMeta.set(name, { type: "gauge", help });
		if (!this.gauges.has(name)) {
			this.gauges.set(name, new Map());
		}
	}

	registerHistogram(name: string, help: string, buckets?: number[]): void {
		this.metricMeta.set(name, { type: "histogram", help });
		this.histogramConfigs.set(name, { buckets: buckets ?? DEFAULT_DURATION_BUCKETS });
		if (!this.histograms.has(name)) {
			this.histograms.set(name, new Map());
		}
	}

	incrementCounter(name: string, labels?: Record<string, string>): void {
		const key = labelsToKey(labels ?? {});
		const map = this.counters.get(name);
		if (!map) return;
		map.set(key, (map.get(key) ?? 0) + 1);
	}

	setGauge(name: string, value: number, labels?: Record<string, string>): void {
		const key = labelsToKey(labels ?? {});
		const map = this.gauges.get(name);
		if (!map) return;
		map.set(key, value);
	}

	incrementGauge(name: string, labels?: Record<string, string>): void {
		const key = labelsToKey(labels ?? {});
		const map = this.gauges.get(name);
		if (!map) return;
		map.set(key, (map.get(key) ?? 0) + 1);
	}

	decrementGauge(name: string, labels?: Record<string, string>): void {
		const key = labelsToKey(labels ?? {});
		const map = this.gauges.get(name);
		if (!map) return;
		map.set(key, (map.get(key) ?? 0) - 1);
	}

	observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
		const config = this.histogramConfigs.get(name);
		const map = this.histograms.get(name);
		if (!config || !map) return;

		const key = labelsToKey(labels ?? {});
		let entry = map.get(key);
		if (!entry) {
			entry = {
				buckets: new Map(config.buckets.map((b) => [b, 0])),
				sum: 0,
				count: 0,
			};
			map.set(key, entry);
		}

		entry.sum += value;
		entry.count += 1;
		for (const bucket of config.buckets) {
			if (value <= bucket) {
				entry.buckets.set(bucket, (entry.buckets.get(bucket) ?? 0) + 1);
			}
		}
	}

	serialize(): string {
		const lines: string[] = [];

		for (const [name, meta] of this.metricMeta) {
			lines.push(`# HELP ${name} ${meta.help}`);
			lines.push(`# TYPE ${name} ${meta.type}`);

			if (meta.type === "counter") {
				this.serializeKeyValueMap(name, this.counters.get(name), lines);
			} else if (meta.type === "gauge") {
				this.serializeKeyValueMap(name, this.gauges.get(name), lines);
			} else if (meta.type === "histogram") {
				this.serializeHistogram(name, lines);
			}
		}

		return lines.length > 0 ? `${lines.join("\n")}\n` : "";
	}

	private serializeKeyValueMap(
		name: string,
		map: Map<string, number> | undefined,
		lines: string[],
	): void {
		if (!map) return;
		for (const [key, value] of map) {
			lines.push(`${name}${key} ${value}`);
		}
	}

	private serializeHistogram(name: string, lines: string[]): void {
		const map = this.histograms.get(name);
		const config = this.histogramConfigs.get(name);
		if (!map || !config) return;

		for (const [key, entry] of map) {
			const baseLabels = parseLabelsFromKey(key);
			for (const bucket of config.buckets) {
				const le = mergeLabels(baseLabels, { le: String(bucket) });
				lines.push(`${name}_bucket${labelsToKey(le)} ${entry.buckets.get(bucket) ?? 0}`);
			}
			const infLabels = mergeLabels(baseLabels, { le: "+Inf" });
			lines.push(`${name}_bucket${labelsToKey(infLabels)} ${entry.count}`);
			lines.push(`${name}_sum${key} ${entry.sum}`);
			lines.push(`${name}_count${key} ${entry.count}`);
		}
	}
}
