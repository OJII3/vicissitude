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
