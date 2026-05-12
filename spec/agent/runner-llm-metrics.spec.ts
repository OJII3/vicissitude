/* oxlint-disable no-non-null-assertion -- deferred セッションを明示的に解決する仕様テスト */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentRunner } from "@vicissitude/agent/runner";
import { METRIC, PrometheusCollector } from "@vicissitude/observability/metrics";
import type { OpencodeSessionEvent, OpencodeSessionPort } from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";
import {
	TestAgent,
	createContextBuilder,
	createProfile,
	createSessionStore,
	deferred,
} from "./runner-test-helpers.ts";

function createCollector(): PrometheusCollector {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.AI_REQUESTS, "AI requests");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "Busy sessions");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "Duration", [1, 5]);
	collector.registerCounter(METRIC.LLM_INPUT_TOKENS, "Input tokens");
	collector.registerCounter(METRIC.LLM_OUTPUT_TOKENS, "Output tokens");
	collector.registerCounter(METRIC.LLM_CACHE_READ_TOKENS, "Cache read tokens");
	collector.registerCounter(METRIC.SESSION_ERRORS, "Session errors");
	collector.registerCounter(METRIC.SESSION_RETRIES, "Session retries");
	collector.registerCounter(METRIC.SESSION_RESTARTS, "Session restarts");
	return collector;
}

function createSessionPort(
	sessionDone: Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & { close: ReturnType<typeof mock> } {
	let callCount = 0;
	const followup = new Promise<OpencodeSessionEvent>(() => {});
	const nextSession = () => {
		callCount += 1;
		return callCount === 1 ? sessionDone : followup;
	};
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "summary", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(nextSession),
		waitForSessionIdle: mock(nextSession),
		deleteSession: mock(() => Promise.resolve()),
		summarizeSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & { close: ReturnType<typeof mock> };
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

describe("AgentRunner LLM metrics", () => {
	test("実際の prompt 完了時に共通ラベル付きで request/duration/token/busy を記録する", async () => {
		const done = deferred<OpencodeSessionEvent>();
		const collector = createCollector();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "discord:guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSessionPort(done.promise),
			sessionMaxAgeMs: 3_600_000,
			metrics: collector,
			contextGuildId: "guild-1",
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "home", message: "hello", guildId: "guild-1" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		done.resolve({ type: "idle", tokens: { input: 100, output: 40, cacheRead: 10 } });
		await Bun.sleep(0);
		await Bun.sleep(0);

		const output = collector.serialize();
		const requestLabels =
			'{agent_id="discord:guild-1",agent_kind="discord",guild_id="guild-1",model="test-model",outcome="success",provider="test-provider",trigger="home"}';
		const commonLabels =
			'{agent_id="discord:guild-1",agent_kind="discord",guild_id="guild-1",model="test-model",provider="test-provider",trigger="home"}';
		expect(output).toContain(`ai_requests_total${requestLabels} 1`);
		expect(output).toContain(`ai_request_duration_seconds_count${requestLabels} 1`);
		expect(output).toContain(`llm_busy_sessions${commonLabels} 0`);
		expect(output).toContain(`llm_input_tokens_total${commonLabels} 100`);
		expect(output).toContain(`llm_output_tokens_total${commonLabels} 40`);
		expect(output).toContain(`llm_cache_read_tokens_total${commonLabels} 10`);
	});

	test("セッションエラーにも共通ラベルを付与する", async () => {
		const done = deferred<OpencodeSessionEvent>();
		const collector = createCollector();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "discord:heartbeat:guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSessionPort(done.promise),
			sessionMaxAgeMs: 3_600_000,
			metrics: collector,
			contextGuildId: "guild-1",
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({
			sessionKey: "system:heartbeat:guild-1",
			message: "heartbeat",
			guildId: "guild-1",
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		done.resolve({ type: "error", message: "timeout", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);

		const output = collector.serialize();
		expect(output).toContain(
			'session_errors_total{agent_id="discord:heartbeat:guild-1",agent_kind="discord_heartbeat",error_class="unknown",error_type="timeout",guild_id="guild-1",http_status="unknown",model="test-model",provider="test-provider",retryable="true",source="session_event",trigger="heartbeat"} 1',
		);
	});
});
