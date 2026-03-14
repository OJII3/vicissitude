/** Minecraft エージェントの agentId */
export const MINECRAFT_AGENT_ID = "minecraft:brain";

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
	LTM_CONSOLIDATION_TICKS: "ltm_consolidation_ticks_total",
	LTM_CONSOLIDATION_TICK_DURATION: "ltm_consolidation_tick_duration_seconds",
	// Token metrics
	LLM_INPUT_TOKENS: "llm_input_tokens_total",
	LLM_OUTPUT_TOKENS: "llm_output_tokens_total",
	LLM_CACHE_READ_TOKENS: "llm_cache_read_tokens_total",
	// Minecraft metrics
	MC_JOBS: "mc_jobs_total",
	MC_BOT_EVENTS: "mc_bot_events_total",
	MC_MCP_TOOL_CALLS: "mc_mcp_tool_calls_total",
	MC_STUCK: "mc_stuck_total",
	MC_COOLDOWNS: "mc_cooldowns_total",
	MC_FAILURE_STREAKS: "mc_failure_streaks_total",
	MC_AUTO_NOTIFICATIONS: "mc_auto_notifications_total",
} as const;

/** OpenCode の全ビルトインツールを無効化する設定 */
export const OPENCODE_ALL_TOOLS_DISABLED: Record<string, boolean> = {
	question: false,
	read: false,
	glob: false,
	grep: false,
	edit: false,
	write: false,
	bash: false,
	webfetch: false,
	websearch: false,
	task: false,
	todowrite: false,
	skill: false,
};
