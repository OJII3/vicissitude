import { METRIC, PrometheusCollector, PrometheusServer } from "@vicissitude/observability/metrics";
import type { Logger } from "@vicissitude/shared/types";

export function createMetrics(logger: Logger, port: number) {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.DISCORD_MESSAGES_RECEIVED, "Discord messages received");
	collector.registerCounter(METRIC.AI_REQUESTS, "Completed AI prompt requests");
	collector.registerCounter(METRIC.HEARTBEAT_TICKS, "Heartbeat scheduler ticks");
	collector.registerCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED, "Heartbeat reminders executed");
	collector.registerGauge(METRIC.BOT_INFO, "Bot information");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "AI prompt duration in seconds");
	collector.registerHistogram(METRIC.HEARTBEAT_TICK_DURATION, "Heartbeat tick duration in seconds");
	collector.registerGauge(METRIC.LLM_ACTIVE_SESSIONS, "Registered LLM sessions");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "LLM prompts currently processing");
	collector.registerCounter(
		METRIC.MEMORY_CONSOLIDATION_TICKS,
		"Memory consolidation scheduler ticks",
	);
	collector.registerHistogram(
		METRIC.MEMORY_CONSOLIDATION_TICK_DURATION,
		"Memory consolidation tick duration in seconds",
	);
	// Token metrics
	collector.registerCounter(METRIC.LLM_INPUT_TOKENS, "LLM input tokens total");
	collector.registerCounter(METRIC.LLM_OUTPUT_TOKENS, "LLM output tokens total");
	collector.registerCounter(METRIC.LLM_CACHE_READ_TOKENS, "LLM cache read tokens total");
	// Cost metrics
	collector.registerCounter(METRIC.LLM_COST_DOLLARS, "LLM cost in US dollars");
	// Session error metrics
	collector.registerCounter(METRIC.SESSION_ERRORS, "Session errors total");
	collector.registerCounter(METRIC.SESSION_RESTARTS, "Session restarts total");
	collector.registerCounter(METRIC.SESSION_RETRIES, "Session retries total");
	// Emotion estimation metrics
	collector.registerCounter(METRIC.EMOTION_ESTIMATION_ERRORS, "Emotion estimation errors total");
	collector.registerCounter(METRIC.EMOTION_ESTIMATION_SKIPS, "Emotion estimation skips total");
	// Drift metrics
	collector.registerGauge(METRIC.DRIFT_SCORE, "Character drift score per guild");
	collector.registerCounter(METRIC.DRIFT_AUDITS, "Character drift audit results");
	collector.registerCounter(METRIC.CRITIC_AUDITOR_SKIP_TOTAL, "Critic auditor skipped audits");
	collector.setGauge(METRIC.BOT_INFO, 1, { bot_name: "hua" });
	return { collector, server: new PrometheusServer(collector, logger, port) };
}
