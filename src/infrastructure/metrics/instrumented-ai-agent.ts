import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";
import type { MetricsCollector } from "../../domain/ports/metrics-collector.port.ts";
import { METRIC } from "./metric-names.ts";

export type AgentType = "opencode" | "copilot";

export function inferTrigger(sessionKey: string): "heartbeat" | "home" | "mention" {
	if (sessionKey.startsWith("system:heartbeat:")) return "heartbeat";
	if (sessionKey.endsWith(":_channel")) return "home";
	return "mention";
}

export class InstrumentedAiAgent implements AiAgent {
	constructor(
		private readonly inner: AiAgent,
		private readonly metrics: MetricsCollector,
		private readonly agentType: AgentType,
	) {}

	async send(options: SendOptions): Promise<AgentResponse> {
		const trigger = inferTrigger(options.sessionKey);
		const labels = { agent_type: this.agentType, trigger };
		const start = performance.now();
		this.metrics.incrementGauge(METRIC.LLM_BUSY_SESSIONS);
		try {
			const response = await this.inner.send(options);
			this.metrics.incrementCounter(METRIC.AI_REQUESTS, { ...labels, outcome: "success" });
			return response;
		} catch (error) {
			this.metrics.incrementCounter(METRIC.AI_REQUESTS, { ...labels, outcome: "error" });
			throw error;
		} finally {
			this.metrics.decrementGauge(METRIC.LLM_BUSY_SESSIONS);
			const duration = (performance.now() - start) / 1000;
			this.metrics.observeHistogram(METRIC.AI_REQUEST_DURATION, duration);
		}
	}

	stop(): void {
		this.inner.stop();
	}
}
