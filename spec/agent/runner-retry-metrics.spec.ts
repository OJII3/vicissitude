/**
 * runner.ts の SESSION_RETRIES メトリクス仕様テスト
 *
 * ## 概要
 *
 * SESSION_RETRIES カウンタはリトライ（backoff 試行）だけを独立して計測する。
 * ローテーション（cap 到達後のエスカレーション）や retryable:false の即時ローテーションでは
 * インクリメントされない。
 *
 * ## ラベル
 *
 * | ラベル     | 値                                       |
 * | ---------- | ---------------------------------------- |
 * | error_type | classifyErrorType の返り値               |
 * | attempt    | リトライ試行番号の文字列 ("1", "2", ...) |
 *
 * ## attempt カウンタのリセット条件
 *
 * - ローテーション後にリセット
 * - idle（正常復帰）後にリセット
 */
/* oxlint-disable max-lines, max-lines-per-function, no-await-in-loop, no-non-null-assertion -- テストファイルはケース数に応じて長くなるため許容。non-null は length チェック後のインデックスアクセスに使用 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AgentRunner, type RunnerDeps } from "@vicissitude/agent/runner";
import { METRIC } from "@vicissitude/observability/metrics";
import type {
	ContextBuilderPort,
	EventBuffer,
	OpencodeSessionEvent,
	OpencodeSessionPort,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "../../packages/agent/src/profile.ts";
import { createMockLogger, createMockMetrics } from "../test-helpers.ts";

// ─── テスト用サブクラス ───────────────────────────────────────────

class TestAgent extends AgentRunner {
	sleepSpy: ((ms: number) => Promise<void>) | null = null;

	// oxlint-disable-next-line no-useless-constructor -- protected → public に昇格させるために必要
	constructor(deps: RunnerDeps) {
		super(deps);
	}

	protected override sleep(ms: number): Promise<void> {
		if (this.sleepSpy) return this.sleepSpy(ms);
		return super.sleep(ms);
	}
}

// ─── ヘルパー ─────────────────────────────────────────────────────

function deferred<T>() {
	let resolveDeferred!: (value: T) => void;
	let rejectDeferred!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolveDeferred = resolve;
		rejectDeferred = reject;
	});
	return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function createProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		name: "conversation",
		mcpServers: {},
		builtinTools: {},
		pollingPrompt: "loop forever",
		restartPolicy: "wait_for_events",
		model: { providerId: "test-provider", modelId: "test-model" },
		...overrides,
	};
}

function createContextBuilder(): ContextBuilderPort {
	return { build: mock(() => Promise.resolve("system prompt")) };
}

function createSessionStore(existingSessionId?: string) {
	let sessionId: string | undefined = existingSessionId;
	const createdAt: number | undefined = existingSessionId ? Date.now() : undefined;
	return {
		get: mock(() => sessionId),
		getRow: mock(() => (sessionId && createdAt ? { key: "k", sessionId, createdAt } : undefined)),
		save: mock((_profile: string, _key: string, nextSessionId: string) => {
			sessionId = nextSessionId;
		}),
		delete: mock(() => {
			sessionId = undefined;
		}),
	};
}

function neverResolve(_signal: AbortSignal): Promise<void> {
	return new Promise(() => {});
}

function createEventBuffer(waitImpl?: (signal: AbortSignal) => Promise<void>): EventBuffer {
	return {
		append: mock(() => {}),
		waitForEvents: mock(waitImpl ?? neverResolve),
	};
}

/**
 * promptAsyncAndWatchSession が毎回 sessions 配列から順番に Promise を返す sessionPort を作成する。
 * sessions 配列を使い切ったら最後の要素を返し続ける。
 */
function createSessionPortWithSessions(
	sessions: Array<Promise<OpencodeSessionEvent>>,
): OpencodeSessionPort & {
	deleteSession: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
} {
	let callCount = 0;
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "summary", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => {
			const idx = Math.min(callCount, sessions.length - 1);
			callCount += 1;
			return sessions[idx];
		}),
		waitForSessionIdle: mock(() => {
			const idx = Math.min(callCount, sessions.length - 1);
			callCount += 1;
			return sessions[idx];
		}),
		deleteSession: mock(() => Promise.resolve()),
		summarizeSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & {
		deleteSession: ReturnType<typeof mock>;
		close: ReturnType<typeof mock>;
	};
}

/** メトリクスの incrementCounter 呼び出しから SESSION_RETRIES のものだけを抽出する */
function extractRetryCalls(metrics: ReturnType<typeof createMockMetrics>) {
	const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
	return incrementCalls.filter((call: unknown[]) => call[0] === METRIC.SESSION_RETRIES);
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

// ─── テスト ───────────────────────────────────────────────────────

describe("SESSION_RETRIES メトリクス: リトライ（backoff）の計測", () => {
	test("retryable:true のエラーで SESSION_RETRIES が attempt=1 でインクリメントされる", async () => {
		const firstEvent = deferred<void>();
		const session1 = deferred<OpencodeSessionEvent>();
		const session2 = deferred<OpencodeSessionEvent>();
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			return Promise.resolve();
		});
		const sessionPort = createSessionPortWithSessions([session1.promise, session2.promise]);
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

		session1.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const retryCalls = extractRetryCalls(metrics);
		expect(retryCalls.length).toBe(1);
		expect((retryCalls[0]![1] as Record<string, string>).error_type).toBe("session_error");
		expect((retryCalls[0]![1] as Record<string, string>).attempt).toBe("1");

		runner.stop();
		session2.resolve({ type: "cancelled" });
	});

	test("連続エラーで attempt が 1, 2, 3 と増加する", async () => {
		const firstEvent = deferred<void>();
		const sessions = [
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
		];
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			return Promise.resolve();
		});
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));
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

		// 1回目のエラー → attempt=1
		sessions[0]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 2回目のエラー → attempt=2
		sessions[1]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 3回目のエラー → attempt=3
		sessions[2]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const retryCalls = extractRetryCalls(metrics);
		expect(retryCalls.length).toBe(3);
		expect((retryCalls[0]![1] as Record<string, string>).attempt).toBe("1");
		expect((retryCalls[1]![1] as Record<string, string>).attempt).toBe("2");
		expect((retryCalls[2]![1] as Record<string, string>).attempt).toBe("3");

		runner.stop();
		sessions[3]?.resolve({ type: "cancelled" });
	});

	test("retryable:false のエラーでは SESSION_RETRIES はインクリメントされない", async () => {
		const firstEvent = deferred<void>();
		const session1 = deferred<OpencodeSessionEvent>();
		const session2 = deferred<OpencodeSessionEvent>();
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			return Promise.resolve();
		});
		const sessionPort = createSessionPortWithSessions([session1.promise, session2.promise]);
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

		// retryable:false → 即時ローテーション、SESSION_RETRIES はインクリメントされない
		session1.resolve({
			type: "error",
			message: "Bad Request",
			status: 400,
			retryable: false,
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const retryCalls = extractRetryCalls(metrics);
		expect(retryCalls.length).toBe(0);

		runner.stop();
		session2.resolve({ type: "cancelled" });
	});

	test("cap 到達後のローテーションでは SESSION_RETRIES はインクリメントされない", async () => {
		const firstEvent = deferred<void>();
		// cap 到達（4回のバックオフ）+ cap 後エラー（1回のローテーション）= 計5セッション + guard
		const sessions = Array.from({ length: 7 }, () => deferred<OpencodeSessionEvent>());
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			return Promise.resolve();
		});
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));
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

		// 1〜4回目のエラー: バックオフ (2s→4s→8s→10s=cap) → SESSION_RETRIES が 4回インクリメント
		for (let i = 0; i < 4; i++) {
			sessions[i]?.resolve({ type: "error", message: "err", retryable: true });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
		}

		const retryCallsBeforeRotation = extractRetryCalls(metrics);
		expect(retryCallsBeforeRotation.length).toBe(4);

		// 5回目のエラー: cap 到達済みなのでローテーション発動 → SESSION_RETRIES は増えない
		sessions[4]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const retryCallsAfterRotation = extractRetryCalls(metrics);
		// ローテーションでは SESSION_RETRIES が増えないので、4回のまま
		expect(retryCallsAfterRotation.length).toBe(4);

		runner.stop();
		sessions[5]?.resolve({ type: "cancelled" });
	});

	test("ローテーション後は attempt がリセットされる", async () => {
		const firstEvent = deferred<void>();
		// cap 到達（4回）+ ローテーション（1回）+ ローテーション後のエラー（1回）+ guard
		const sessions = Array.from({ length: 8 }, () => deferred<OpencodeSessionEvent>());
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			return Promise.resolve();
		});
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));
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

		// 1〜4回目: バックオフで cap 到達 (attempt=1,2,3,4)
		for (let i = 0; i < 4; i++) {
			sessions[i]?.resolve({ type: "error", message: "err", retryable: true });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
		}

		// 5回目: ローテーション発動
		sessions[4]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// ローテーション後の新エラー → attempt は 1 にリセットされている
		sessions[5]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const retryCalls = extractRetryCalls(metrics);
		// 最後の retry call は attempt="1"（リセット後の初回）
		const lastRetryCall = retryCalls.at(-1)!;
		expect((lastRetryCall[1] as Record<string, string>).attempt).toBe("1");

		runner.stop();
		sessions[6]?.resolve({ type: "cancelled" });
	});

	test("idle 後は attempt がリセットされる", async () => {
		const firstEvent = deferred<void>();
		// [0] error(attempt=1), [1] error(attempt=2), [2] idle(reset),
		// [3] error(attempt=1 に戻る), [4] guard
		const sessions = [
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
		];
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			return Promise.resolve();
		});
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));
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

		// エラー → attempt=1
		sessions[0]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラー → attempt=2
		sessions[1]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const retryCallsBeforeIdle = extractRetryCalls(metrics);
		expect(retryCallsBeforeIdle.length).toBe(2);
		expect((retryCallsBeforeIdle[1]![1] as Record<string, string>).attempt).toBe("2");

		// idle（正常復帰）→ attempt リセット
		sessions[2]?.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// idle 後のエラー → attempt は 1 にリセットされている
		sessions[3]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const retryCallsAfterIdle = extractRetryCalls(metrics);
		const lastRetryCall = retryCallsAfterIdle.at(-1)!;
		expect((lastRetryCall[1] as Record<string, string>).attempt).toBe("1");

		runner.stop();
		sessions[4]?.resolve({ type: "cancelled" });
	});
});
