import type { Part } from "@opencode-ai/sdk/v2";
import type { OpencodeSessionActivity } from "@vicissitude/shared/types";

type ParsedTaskOutput = {
	taskId?: string;
	state?: string;
	result?: string;
	error?: string;
	hasResult: boolean;
	hasError: boolean;
};

export function extractBackgroundTaskFailure(part: Part): OpencodeSessionActivity | null {
	if (part.type === "text") {
		if (!part.text.startsWith("Background task completed:")) return null;
		return failureFromParsedTaskOutput(parseTaskOutput(part.text));
	}
	if (
		part.type !== "tool" ||
		part.state.status !== "completed" ||
		(part.tool !== "task" && part.tool !== "task_status")
	) {
		return null;
	}
	return failureFromParsedTaskOutput(parseTaskOutput(part.state.output));
}

function parseTaskOutput(output: string): ParsedTaskOutput {
	return {
		taskId: matchLine(output, "task_id"),
		state: matchLine(output, "state"),
		result: matchBlock(output, "task_result"),
		error: matchBlock(output, "task_error"),
		hasResult: output.includes("<task_result>"),
		hasError: output.includes("<task_error>"),
	};
}

function failureFromParsedTaskOutput(parsed: ParsedTaskOutput): OpencodeSessionActivity | null {
	const taskLabel = parsed.taskId ? `task ${parsed.taskId}` : "task";
	if (parsed.state === "error" || parsed.hasError) {
		const error = parsed.error?.trim() ?? "unknown task error";
		return {
			type: "backgroundTaskFailure",
			taskId: parsed.taskId,
			state: parsed.state,
			reason: "task_error",
			message: `shell-worker ${taskLabel} failed: ${error}`,
		};
	}
	if (parsed.hasResult && parsed.result?.trim().length === 0) {
		return {
			type: "backgroundTaskFailure",
			taskId: parsed.taskId,
			state: parsed.state,
			reason: "empty_result",
			message: `shell-worker ${taskLabel} completed with an empty task_result`,
		};
	}
	return null;
}

function matchLine(text: string, key: "task_id" | "state"): string | undefined {
	return text.match(new RegExp(`^${key}:\\s*(\\S+)`, "m"))?.[1];
}

function matchBlock(text: string, tag: "task_result" | "task_error"): string | undefined {
	return text.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?<\\/${tag}>`, "m"))?.[1];
}
