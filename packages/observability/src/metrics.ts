/* oxlint-disable max-classes-per-file, max-lines -- metrics module consolidates related classes */
import type { Logger, MetricsCollector, TokenUsage } from "@vicissitude/shared/types";

import { calculateCost, getModelPricing } from "./model-pricing.ts";

// ─── Metric Names ───────────────────────────────────────────────

export const METRIC = {
	DISCORD_MESSAGES_RECEIVED: "discord_messages_received_total",
	AI_REQUESTS: "ai_requests_total",
	HEARTBEAT_TICKS: "heartbeat_ticks_total",
	HEARTBEAT_REMINDERS_EXECUTED: "heartbeat_reminders_executed_total",
	BOT_INFO: "bot_info",
	AI_REQUEST_DURATION: "ai_request_duration_seconds",
	HEARTBEAT_TICK_DURATION: "heartbeat_tick_duration_seconds",
	LLM_ACTIVE_SESSIONS: "llm_active_sessions",
	LLM_BUSY_SESSIONS: "llm_busy_sessions",
	MEMORY_CONSOLIDATION_TICKS: "memory_consolidation_ticks_total",
	MEMORY_CONSOLIDATION_TICK_DURATION: "memory_consolidation_tick_duration_seconds",
	// Token metrics
	LLM_INPUT_TOKENS: "llm_input_tokens_total",
	LLM_OUTPUT_TOKENS: "llm_output_tokens_total",
	LLM_CACHE_READ_TOKENS: "llm_cache_read_tokens_total",
	// Core MCP metrics
	MCP_TOOL_CALLS: "mcp_tool_calls_total",
	// Minecraft metrics
	MC_JOBS: "mc_jobs_total",
	MC_BOT_EVENTS: "mc_bot_events_total",
	MC_MCP_TOOL_CALLS: "mc_mcp_tool_calls_total",
	MC_STUCK: "mc_stuck_total",
	MC_COOLDOWNS: "mc_cooldowns_total",
	MC_FAILURE_STREAKS: "mc_failure_streaks_total",
	MC_AUTO_NOTIFICATIONS: "mc_auto_notifications_total",
	// Drift metrics
	DRIFT_SCORE: "drift_score",
	DRIFT_AUDITS: "drift_audits_total",
	CRITIC_AUDITOR_SKIP_TOTAL: "critic_auditor_skip_total",
	// Cost metrics
	LLM_COST_DOLLARS: "llm_cost_dollars_total",
	LLM_PRICING_UNKNOWN: "llm_pricing_unknown_total",
	// Session error metrics
	SESSION_ERRORS: "session_errors_total",
	SESSION_RESTARTS: "session_restarts_total",
	SESSION_RETRIES: "session_retries_total",
	// Emotion estimation metrics
	EMOTION_ESTIMATION_ERRORS: "emotion_estimation_errors_total",
	EMOTION_ESTIMATION_SKIPS: "emotion_estimation_skips_total",
} as const;

// ─── labelsToKey ─────────────────────────────────────────────────

/** Prometheus ラベルを `{k1="v1",k2="v2"}` 形式のキーに変換する */
export function labelsToKey(labels: Record<string, string>): string {
	const entries = Object.entries(labels).toSorted(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "";
	return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

/** Prometheus テキストフォーマット用のラベル値エスケープ */
function escapeLabel(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

// ─── Token Metrics Helper ───────────────────────────────────────

export function recordTokenMetrics(
	metrics: MetricsCollector,
	tokens: TokenUsage,
	labels: Record<string, string>,
	modelId?: string,
): void {
	if (tokens.input > 0) metrics.addCounter(METRIC.LLM_INPUT_TOKENS, tokens.input, labels);
	if (tokens.output > 0) metrics.addCounter(METRIC.LLM_OUTPUT_TOKENS, tokens.output, labels);
	if (tokens.cacheRead > 0)
		metrics.addCounter(METRIC.LLM_CACHE_READ_TOKENS, tokens.cacheRead, labels);

	if (modelId) {
		const pricing = getModelPricing(modelId);
		if (pricing) {
			const cost = calculateCost(tokens, pricing);
			if (cost > 0) {
				metrics.addCounter(METRIC.LLM_COST_DOLLARS, cost, { ...labels, model: modelId });
			}
		} else {
			metrics.incrementCounter(METRIC.LLM_PRICING_UNKNOWN, { ...labels, model: modelId });
		}
	}
}

// ─── Agent Metric Labels ────────────────────────────────────────

const HEARTBEAT_SESSION_PREFIX = "system:heartbeat:";

export interface AgentMetricLabelOptions {
	agentId: string;
	scopeId?: string;
	sessionKey?: string;
	trigger?: string;
	providerId: string;
	modelId: string;
}

export function inferAgentKind(agentId: string): string {
	if (agentId.startsWith("discord:heartbeat:")) return "discord_heartbeat";
	if (agentId.startsWith("discord:")) return "discord";
	if (agentId.startsWith("minecraft:")) return "minecraft";
	return "unknown";
}

export function inferTrigger(sessionKey: string): string {
	if (sessionKey === "home" || sessionKey.endsWith(":_channel")) return "home";
	if (sessionKey.startsWith(HEARTBEAT_SESSION_PREFIX)) return "heartbeat";
	if (sessionKey.startsWith("discord:heartbeat:")) return "heartbeat";
	if (sessionKey === "mention" || sessionKey.startsWith("discord:")) return "mention";
	if (sessionKey.startsWith("minecraft:")) return "minecraft";
	return "unknown";
}

export function inferScopeId(sessionKey: string): string | undefined {
	if (sessionKey.startsWith(HEARTBEAT_SESSION_PREFIX)) {
		return sessionKey.slice(HEARTBEAT_SESSION_PREFIX.length);
	}

	if (sessionKey.startsWith("discord:guild:")) {
		return sessionKey;
	}

	if (sessionKey.startsWith("discord:")) {
		const [, first, second] = sessionKey.split(":");
		const discordId = first === "heartbeat" ? second : first;
		return discordId ? `discord:guild:${discordId}` : undefined;
	}

	return undefined;
}

function inferScopeIdFromAgentId(agentId: string): string | undefined {
	if (agentId.startsWith("discord:heartbeat:")) {
		return `discord:guild:${agentId.slice("discord:heartbeat:".length)}`;
	}
	if (agentId.startsWith("discord:")) return `discord:guild:${agentId.slice("discord:".length)}`;
	return undefined;
}

export function buildAgentMetricLabels(options: AgentMetricLabelOptions): Record<string, string> {
	const sessionScopeId = options.sessionKey ? inferScopeId(options.sessionKey) : undefined;
	const scopeId =
		options.scopeId ?? sessionScopeId ?? inferScopeIdFromAgentId(options.agentId) ?? "none";
	const trigger =
		options.trigger ?? (options.sessionKey ? inferTrigger(options.sessionKey) : "unknown");

	return {
		agent_kind: inferAgentKind(options.agentId),
		agent_id: options.agentId,
		scope_id: scopeId,
		trigger,
		provider: options.providerId,
		model: options.modelId,
	};
}

// ─── Error Classification ───────────────────────────────────────

export function classifyErrorType(event: {
	status?: number;
	retryable?: boolean;
	errorClass?: string;
	message?: string;
}): string {
	if (event.status === 429) return "rate_limit";
	const msg = event.message?.toLowerCase() ?? "";
	if (msg.includes("context_length") || msg.includes("max_tokens"))
		return "context_length_exceeded";
	if (msg.includes("content_filter") || msg.includes("content_management")) return "content_filter";
	if (msg.includes("timed out") || msg.includes("timeout")) return "timeout";
	return "session_error";
}

// ─── Prometheus Collector ───────────────────────────────────────

interface MetricMeta {
	type: "counter" | "gauge" | "histogram";
	help: string;
}

interface HistogramConfig {
	buckets: number[];
}

interface HistogramEntry {
	labels: Record<string, string>;
	buckets: Map<number, number>;
	sum: number;
	count: number;
}

const DEFAULT_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

function mergeLabels(
	base: Record<string, string> | undefined,
	extra: Record<string, string>,
): Record<string, string> {
	return base && Object.keys(base).length > 0 ? { ...base, ...extra } : extra;
}

export class PrometheusCollector implements MetricsCollector {
	private counters = new Map<string, Map<string, number>>();
	private gauges = new Map<string, Map<string, number>>();
	private histograms = new Map<string, Map<string, HistogramEntry>>();
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

	addCounter(name: string, value: number, labels?: Record<string, string>): void {
		if (value <= 0) return;
		const key = labelsToKey(labels ?? {});
		const map = this.counters.get(name);
		if (!map) return;
		map.set(key, (map.get(key) ?? 0) + value);
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

		const baseLabels = labels ?? {};
		const key = labelsToKey(baseLabels);
		let entry = map.get(key);
		if (!entry) {
			entry = {
				labels: { ...baseLabels },
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

		for (const [, entry] of map) {
			const baseLabels = entry.labels;
			for (const bucket of config.buckets) {
				const le = mergeLabels(baseLabels, { le: String(bucket) });
				lines.push(`${name}_bucket${labelsToKey(le)} ${entry.buckets.get(bucket) ?? 0}`);
			}
			const infLabels = mergeLabels(baseLabels, { le: "+Inf" });
			lines.push(`${name}_bucket${labelsToKey(infLabels)} ${entry.count}`);
			lines.push(`${name}_sum${labelsToKey(baseLabels)} ${entry.sum}`);
			lines.push(`${name}_count${labelsToKey(baseLabels)} ${entry.count}`);
		}
	}
}

// ─── Prometheus Server ──────────────────────────────────────────

export class PrometheusServer {
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- Bun.serve の戻り値型が any を含むため
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(
		private readonly collector: PrometheusCollector,
		private readonly logger: Logger,
		private readonly port: number,
		private readonly hostname: string = "0.0.0.0",
	) {}

	start(): void {
		this.server = Bun.serve({
			port: this.port,
			hostname: this.hostname,
			fetch: (req: Request) => this.handleRequest(req),
		});
		this.logger.info(
			`[metrics] Prometheus server listening on ${this.hostname}:${String(this.port)}`,
		);
	}

	stop(): void {
		if (this.server) {
			this.server.stop();
			this.server = null;
			this.logger.info("[metrics] Prometheus server stopped");
		}
	}

	private handleRequest(req: Request): Response {
		const url = new URL(req.url);

		if (url.pathname === "/metrics") {
			return new Response(this.collector.serialize(), {
				headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
			});
		}

		if (url.pathname === "/health") {
			return new Response("ok");
		}

		return new Response("Not Found", { status: 404 });
	}
}
