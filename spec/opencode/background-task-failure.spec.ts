import { describe, expect, test } from "bun:test";

import type { Event } from "@opencode-ai/sdk/v2";
import { extractPartActivity } from "@vicissitude/opencode/stream-helpers";

function makePartEvent(partProps: Record<string, unknown>, sessionId = "parent-session"): Event {
	return {
		type: "message.part.updated",
		properties: {
			sessionID: sessionId,
			part: { sessionID: sessionId, ...partProps },
			time: Date.now(),
		},
	} as unknown as Event;
}

describe("background task failure activity", () => {
	test("Background task completed の空 task_result を失敗 activity として返す", () => {
		const event = makePartEvent({
			type: "text",
			text: `Background task completed: 3分スリープタスク
task_id: task-1
state: completed

<task_result>

</task_result>`,
		});

		const result = extractPartActivity(event, "parent-session");

		expect(result).toEqual({
			type: "backgroundTaskFailure",
			taskId: "task-1",
			state: "completed",
			reason: "empty_result",
			message: "shell-worker task task-1 completed with an empty task_result",
		});
	});

	test("task_status の state:error と task_error を失敗 activity として返す", () => {
		const event = makePartEvent({
			type: "tool",
			tool: "task_status",
			state: {
				status: "completed",
				input: { task_id: "task-2", wait: true },
				output: `task_id: task-2
state: error

<task_error>
Token refresh failed: 401
</task_error>`,
				title: "task_status",
				metadata: {},
				time: { start: 100, end: 110 },
			},
		});

		const result = extractPartActivity(event, "parent-session");

		expect(result).toEqual({
			type: "backgroundTaskFailure",
			taskId: "task-2",
			state: "error",
			reason: "task_error",
			message: "shell-worker task task-2 failed: Token refresh failed: 401",
		});
	});

	test("非空 task_result は失敗扱いしない", () => {
		const event = makePartEvent({
			type: "text",
			text: `Background task completed: build
task_id: task-3
state: completed

<task_result>
Build succeeded
</task_result>`,
		});

		expect(extractPartActivity(event, "parent-session")).toBeNull();
	});
});
