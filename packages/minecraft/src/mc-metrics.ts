import { METRIC } from "@vicissitude/shared/constants";
import { labelsToKey } from "@vicissitude/shared/functions";
import type { Logger, MetricsCollector } from "@vicissitude/shared/types";

// ─── Lightweight Prometheus Collector for MC MCP process ────────
// PrometheusCollector の再利用ではなく、MC プロセス専用の最小限実装

export class McMetricsCollector implements MetricsCollector {
	private counters = new Map<string, { help: string; values: Map<string, number> }>();

	registerCounter(name: string, help: string): void {
		if (!this.counters.has(name)) {
			this.counters.set(name, { help, values: new Map() });
		}
	}

	incrementCounter(name: string, labels?: Record<string, string>): void {
		const entry = this.counters.get(name);
		if (!entry) return;
		const key = labelsToKey(labels ?? {});
		entry.values.set(key, (entry.values.get(key) ?? 0) + 1);
	}

	addCounter(name: string, value: number, labels?: Record<string, string>): void {
		if (value <= 0) return;
		const entry = this.counters.get(name);
		if (!entry) return;
		const key = labelsToKey(labels ?? {});
		entry.values.set(key, (entry.values.get(key) ?? 0) + value);
	}

	// MetricsCollector の他メソッドは MC では不使用だが、インターフェース充足のため定義
	setGauge(_name: string, _value: number, _labels?: Record<string, string>): void {}
	incrementGauge(_name: string, _labels?: Record<string, string>): void {}
	decrementGauge(_name: string, _labels?: Record<string, string>): void {}
	observeHistogram(_name: string, _value: number, _labels?: Record<string, string>): void {}

	serialize(): string {
		const lines: string[] = [];
		for (const [name, { help, values }] of this.counters) {
			lines.push(`# HELP ${name} ${help}`);
			lines.push(`# TYPE ${name} counter`);
			for (const [key, value] of values) {
				lines.push(`${name}${key} ${value}`);
			}
		}
		return lines.length > 0 ? `${lines.join("\n")}\n` : "";
	}
}

export interface McMetricsServer {
	start(): void;
	stop(): void;
}

export function createMcMetrics(logger: Logger): {
	collector: McMetricsCollector;
	server: McMetricsServer;
} {
	const port = Number(process.env.MC_METRICS_PORT) || 9092;
	const collector = new McMetricsCollector();
	collector.registerCounter(METRIC.MC_JOBS, "Minecraft jobs total");
	collector.registerCounter(METRIC.MC_BOT_EVENTS, "Minecraft bot events total");
	collector.registerCounter(METRIC.MC_MCP_TOOL_CALLS, "Minecraft MCP tool calls total");
	collector.registerCounter(METRIC.MC_STUCK, "Minecraft stuck detections total");
	collector.registerCounter(METRIC.MC_COOLDOWNS, "Minecraft cooldown activations total");
	collector.registerCounter(METRIC.MC_FAILURE_STREAKS, "Minecraft failure streak increments total");
	collector.registerCounter(
		METRIC.MC_AUTO_NOTIFICATIONS,
		"Minecraft auto Discord notifications total",
	);

	let bunServer: ReturnType<typeof Bun.serve> | null = null;

	const server: McMetricsServer = {
		start() {
			const hostname = process.env.MC_METRICS_HOST ?? "0.0.0.0";
			bunServer = Bun.serve({
				port,
				hostname,
				fetch: (req) => {
					const url = new URL(req.url);
					if (url.pathname === "/metrics") {
						return new Response(collector.serialize(), {
							headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
						});
					}
					if (url.pathname === "/health") return new Response("ok");
					return new Response("Not Found", { status: 404 });
				},
			});
			logger.info(`[mc-metrics] Prometheus server listening on ${hostname}:${String(port)}`);
		},
		stop() {
			if (bunServer) {
				bunServer.stop();
				bunServer = null;
				logger.info("[mc-metrics] Prometheus server stopped");
			}
		},
	};

	return { collector, server };
}
