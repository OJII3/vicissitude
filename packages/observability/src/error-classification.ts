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
