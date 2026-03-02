import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { MetricsCollector } from "../../domain/ports/metrics-collector.port.ts";
import { METRIC } from "./metric-names.ts";

export class InstrumentedAiAgent implements AiAgent {
	constructor(
		private readonly inner: AiAgent,
		private readonly metrics: MetricsCollector,
	) {}

	async send(options: SendOptions): Promise<AgentResponse> {
		const start = performance.now();
		try {
			const response = await this.inner.send(options);
			this.metrics.incrementCounter(METRIC.AI_REQUESTS, { outcome: "success" });
			return response;
		} catch (error) {
			this.metrics.incrementCounter(METRIC.AI_REQUESTS, { outcome: "error" });
			throw error;
		} finally {
			const duration = (performance.now() - start) / 1000;
			this.metrics.observeHistogram(METRIC.AI_REQUEST_DURATION, duration);
		}
	}

	stop(): void {
		this.inner.stop();
	}
}
