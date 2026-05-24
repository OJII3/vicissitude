import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentRunner } from "@vicissitude/agent/runner";
import { createMockLogger } from "@vicissitude/shared/test-helpers";
import type {
	OpencodePromptParams,
	OpencodeSessionEvent,
	OpencodeSessionPort,
} from "@vicissitude/shared/types";

import {
	TestAgent,
	createContextBuilder,
	createProfile,
	createSessionStore,
	deferred,
} from "./runner-test-helpers.ts";

function createSessionPort() {
	const firstDone = deferred<OpencodeSessionEvent>();
	const secondDone = deferred<OpencodeSessionEvent>();
	let callCount = 0;
	let firstSignal: AbortSignal | undefined;
	const port = {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock((_params: OpencodePromptParams, signal?: AbortSignal) => {
			callCount += 1;
			if (callCount === 1) {
				firstSignal = signal;
				return firstDone.promise;
			}
			return secondDone.promise;
		}),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		summarizeSession: mock(() => Promise.resolve()),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	};
	return {
		port: port as unknown as OpencodeSessionPort,
		firstDone,
		secondDone,
		firstSignal: () => firstSignal,
	};
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) runner.stop();
	activeRunners.clear();
});

describe("AgentRunner: background task failure", () => {
	test("shell-worker の空結果失敗を内部メッセージとして積み、現 turn を中断して再プロンプトする", async () => {
		const { port, firstDone, secondDone, firstSignal } = createSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "discord:guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: port,
			sessionMaxAgeMs: 3_600_000,
			contextScopeId: "discord:guild:guild-1",
		});
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "3分 sleep を shell-worker で実行して" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		const firstParams = (port.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock
			.calls[0]?.[0] as OpencodePromptParams;
		firstParams.onActivity?.({
			type: "backgroundTaskFailure",
			taskId: "task-1",
			state: "completed",
			reason: "empty_result",
			message: "shell-worker task task-1 completed with an empty task_result",
		});

		await Bun.sleep(0);
		expect(firstSignal()?.aborted).toBe(true);

		firstDone.resolve({ type: "cancelled" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(port.promptAsyncAndWatchSession).toHaveBeenCalledTimes(2);
		const secondParams = (port.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock
			.calls[1]?.[0] as OpencodePromptParams;
		expect(secondParams.text).toContain("3分 sleep を shell-worker で実行して");
		expect(secondParams.text).toContain("shell-worker background task failed");
		expect(secondParams.text).toContain("task-1");
		expect(secondParams.text).toContain("empty task_result");

		runner.stop();
		secondDone.resolve({ type: "cancelled" });
	});
});
