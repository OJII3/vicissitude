/**
 * セッションエラー検知改善: Runner のリトライメトリクスの仕様テスト
 *
 * 期待仕様:
 * 1. handleSessionEnd で error が返った場合、SESSION_ERRORS カウンタがインクリメントされる
 * 2. handleSessionEnd で streamDisconnected が返った場合、SESSION_ERRORS カウンタがインクリメントされる
 * 3. エラー/streamDisconnected 後の再起動時に SESSION_RESTARTS カウンタがインクリメントされる
 * 4. ハング検知によるセッションローテーション時に SESSION_RESTARTS がインクリメントされる
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentRunner } from "@vicissitude/agent/runner";
import { METRIC } from "@vicissitude/observability/metrics";
import type { OpencodeSessionEvent, OpencodeSessionPort } from "@vicissitude/shared/types";

import { createMockLogger, createMockMetrics } from "../test-helpers.ts";
import {
	TestAgent,
	createContextBuilder,
	createEventBuffer,
	createProfile,
	createSessionStore,
	deferred,
} from "./runner-test-helpers.ts";

// ─── ヘルパー ─────────────────────────────────────────────────────

function createSessionPortWithControlledResult(
	firstDone: Promise<OpencodeSessionEvent>,
	secondDone: Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & { close: ReturnType<typeof mock> } {
	let callCount = 0;
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "summary", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => {
			callCount += 1;
			return callCount === 1 ? firstDone : secondDone;
		}),
		waitForSessionIdle: mock(() => {
			callCount += 1;
			return callCount <= 2 ? firstDone : secondDone;
		}),
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

// ─── テスト ───────────────────────────────────────────────────────

describe("Runner: session error メトリクス記録", () => {
	test("セッションが error で終了した場合、SESSION_ERRORS カウンタがインクリメントされる", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithControlledResult(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const metrics = createMockMetrics();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "error", message: "session failed" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const sessionErrorCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_ERRORS,
		);
		expect(sessionErrorCalls.length).toBeGreaterThanOrEqual(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("セッションが streamDisconnected で終了した場合、SESSION_ERRORS カウンタがインクリメントされる", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithControlledResult(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const metrics = createMockMetrics();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "streamDisconnected" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const sessionErrorCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_ERRORS,
		);
		expect(sessionErrorCalls.length).toBeGreaterThanOrEqual(1);
		// ラベルセットが session_error と揃っていること（Prometheus 系列一貫性のため）
		const labels = sessionErrorCalls[0]?.[1] as Record<string, string> | undefined;
		expect(labels?.http_status).toBe("unknown");
		expect(labels?.retryable).toBe("unknown");
		expect(labels?.error_class).toBe("unknown");

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("error イベントに status/retryable/errorClass が含まれる場合、ラベルとして記録される", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithControlledResult(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const metrics = createMockMetrics();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({
			type: "error",
			message: "Bad Request",
			status: 400,
			retryable: false,
			errorClass: "APIError",
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const sessionErrorCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_ERRORS,
		);
		expect(sessionErrorCalls.length).toBeGreaterThanOrEqual(1);
		const sessionErrorLabels = sessionErrorCalls[0]?.[1] as Record<string, string> | undefined;
		expect(sessionErrorLabels?.http_status).toBe("400");
		expect(sessionErrorLabels?.retryable).toBe("false");
		expect(sessionErrorLabels?.error_class).toBe("APIError");

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("error イベントに構造化フィールドが無い場合、ラベルは unknown", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithControlledResult(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const metrics = createMockMetrics();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "error", message: "unknown failure" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const sessionErrorCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_ERRORS,
		);
		expect(sessionErrorCalls.length).toBeGreaterThanOrEqual(1);
		const labels = sessionErrorCalls[0]?.[1] as Record<string, string> | undefined;
		expect(labels?.http_status).toBe("unknown");
		expect(labels?.retryable).toBe("unknown");
		expect(labels?.error_class).toBe("unknown");

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});
});

describe("Runner: session restart メトリクス記録", () => {
	test("エラー後の再起動時に SESSION_RESTARTS カウンタがインクリメントされる", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithControlledResult(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const metrics = createMockMetrics();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "error", message: "session failed" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const restartCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_RESTARTS,
		);
		expect(restartCalls.length).toBeGreaterThanOrEqual(1);
		// reason ラベルにエラー系の値が含まれる（retryable:undefined は retryable:true 扱いでバックオフ）
		const errorRestarts = restartCalls.filter((call: unknown[]) => {
			const reason = (call[1] as Record<string, string> | undefined)?.reason;
			return (
				reason === "error_retryable_backoff" ||
				reason === "error_retryable_rotation" ||
				reason === "error_non_retryable_rotation"
			);
		});
		expect(errorRestarts.length).toBeGreaterThanOrEqual(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("streamDisconnected は SSE 再購読のみなので SESSION_RESTARTS はインクリメントされない", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithControlledResult(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const metrics = createMockMetrics();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "streamDisconnected" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		// SESSION_ERRORS は記録される
		const sessionErrorCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_ERRORS,
		);
		expect(sessionErrorCalls.length).toBeGreaterThanOrEqual(1);
		// SESSION_RESTARTS はインクリメントされない（セッション再起動ではなくSSE再購読のため）
		const restartCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_RESTARTS,
		);
		expect(restartCalls.length).toBe(0);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("ハング検知によるセッションローテーション時に SESSION_RESTARTS がインクリメントされる", async () => {
		const eventBuffer = createEventBuffer(() => new Promise(() => {}));
		const sessionPort = createSessionPortWithControlledResult(
			new Promise(() => {}),
			new Promise(() => {}),
		);
		const metrics = createMockMetrics();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore("existing-session-id") as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			hangTimeoutMs: 100,
			metrics,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		await Bun.sleep(150);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const restartCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_RESTARTS,
		);
		const hangRestarts = restartCalls.filter(
			(call: unknown[]) =>
				(call[1] as Record<string, string> | undefined)?.reason === "hang_detected",
		);
		expect(hangRestarts.length).toBeGreaterThanOrEqual(1);

		runner.stop();
	});
});
