/**
 * runner.ts の session error 戦略仕様テスト
 *
 * ## エラー戦略概要
 *
 * - `retryable:true` (または undefined/unknown → デフォルトで true 扱い):
 *   exponential backoff (2s → 4s → 8s → 10s, cap=10s) でリトライ。
 *   cap (10s) 到達後もエラーが継続した場合、opencode session rotation にエスカレーション。
 *
 * - `retryable:false`:
 *   backoff せず即座に session rotation。
 *
 * - rotation 後も同じロジックを再度回す（ランナー停止はしない）。
 * - 正常復帰 (idle) 後は delay をリセット。
 *
 * ## SESSION_RESTARTS reason ラベル
 *
 * | reason                      | 意味                                              |
 * | --------------------------- | ------------------------------------------------- |
 * | error_retryable_backoff     | retryable:true でバックオフ中の再起動             |
 * | error_retryable_rotation    | retryable:true で cap 到達後のローテーション      |
 * | error_non_retryable_rotation| retryable:false の即時ローテーション              |
 */
/* oxlint-disable max-lines, max-lines-per-function, no-await-in-loop -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AgentRunner, type RunnerDeps } from "@vicissitude/agent/runner";
import { METRIC } from "@vicissitude/observability/metrics";
import type {
	ContextBuilderPort,
	OpencodeSessionEvent,
	OpencodeSessionPort,
	SessionSummaryWriter,
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

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

// ─── テスト ───────────────────────────────────────────────────────

describe("retryable:true のバックオフ戦略", () => {
	test("retryable:true のエラーで 2s → 4s → 8s → 10s の sleep 列になる", async () => {
		const sessions = [
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
		];
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));
		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1回目のエラー → sleep 2s
		sessions[0]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 2回目のエラー → sleep 4s
		sessions[1]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 3回目のエラー → sleep 8s
		sessions[2]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 4回目のエラー → sleep 10s (cap)
		sessions[3]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// バックオフ数列が 2s → 4s → 8s → 10s になっている
		expect(sleepValues.slice(0, 4)).toEqual([2000, 4000, 8000, 10000]);

		runner.stop();
		sessions[4]?.resolve({ type: "cancelled" });
	});

	test("retryable:true で cap(10s) 到達後もエラーが継続するとローテーションにエスカレーション", async () => {
		// cap 到達（4回）+ cap 後エラー（1回）= 計5セッション
		const sessions = [
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
		];
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1〜4回目のエラー: バックオフ (2s→4s→8s→10s=cap)
		for (let i = 0; i < 4; i++) {
			sessions[i]?.resolve({ type: "error", message: "err", retryable: true });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
		}

		// 5回目のエラー: cap 到達済みなのでローテーション発動
		sessions[4]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// deleteSession が呼ばれた（ローテーション発動）
		expect(sessionPort.deleteSession).toHaveBeenCalled();

		runner.stop();
		sessions[5]?.resolve({ type: "cancelled" });
	});

	test("retryable undefined のエラーは retryable:true として扱われバックオフする", async () => {
		const session1 = deferred<OpencodeSessionEvent>();
		const session2 = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortWithSessions([session1.promise, session2.promise]);

		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// retryable フィールドなし → retryable:true 扱いでバックオフ
		session1.resolve({ type: "error", message: "unknown error" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// sleep が呼ばれた（即時ローテーションではなくバックオフ）
		expect(sleepValues.length).toBeGreaterThanOrEqual(1);
		// 即時ローテーションではないので deleteSession は呼ばれない
		expect((sessionPort.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);

		runner.stop();
		session2.resolve({ type: "cancelled" });
	});
});

describe("retryable:false の即時ローテーション戦略", () => {
	test("retryable:false のエラーで sleep なく即座に rotation が発動する", async () => {
		const session1 = deferred<OpencodeSessionEvent>();
		const session2 = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortWithSessions([session1.promise, session2.promise]);

		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// retryable:false → 即時ローテーション
		session1.resolve({ type: "error", message: "Bad Request", status: 400, retryable: false });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// deleteSession が呼ばれた
		expect(sessionPort.deleteSession).toHaveBeenCalled();
		// 2s 以上の sleep は発生していない
		const longSleeps = sleepValues.filter((ms) => ms >= 2000);
		expect(longSleeps.length).toBe(0);

		runner.stop();
		session2.resolve({ type: "cancelled" });
	});

	test("retryable:false のローテーションでは sessionPort.prompt (要約生成) が呼ばれない", async () => {
		const session1 = deferred<OpencodeSessionEvent>();
		const session2 = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortWithSessions([session1.promise, session2.promise]);
		const summaryWriter: SessionSummaryWriter = {
			write: mock(() => Promise.resolve()),
		};

		const runner = new TestAgent({
			profile: createProfile({ summaryPrompt: "要約してください" }),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			contextGuildId: "123456789",
			summaryWriter,
			summaryTimeoutMs: 100,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// retryable:false → 即時ローテーション（サマリ生成スキップ）
		session1.resolve({ type: "error", message: "Bad Request", status: 400, retryable: false });
		await Bun.sleep(50);

		// rotation は発動するが、prompt (要約生成) は呼ばれない
		expect(sessionPort.deleteSession).toHaveBeenCalled();
		expect(
			(sessionPort as unknown as { prompt: ReturnType<typeof mock> }).prompt,
		).toHaveBeenCalledTimes(0);
		expect(summaryWriter.write).toHaveBeenCalledTimes(0);

		runner.stop();
		session2.resolve({ type: "cancelled" });
	});

	test("retryable:false のローテーション後も再エラーで同じロジックが回る（ランナー停止しない）", async () => {
		const sessions = [
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
		];
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1回目: retryable:false → 即時ローテーション
		sessions[0]?.resolve({ type: "error", message: "err", retryable: false });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const deleteCallCount1 = (sessionPort.deleteSession as ReturnType<typeof mock>).mock.calls
			.length;
		expect(deleteCallCount1).toBeGreaterThanOrEqual(1);

		// 2回目: 再度 retryable:false → 再ローテーション（ランナー停止していない）
		sessions[1]?.resolve({ type: "error", message: "err", retryable: false });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const deleteCallCount2 = (sessionPort.deleteSession as ReturnType<typeof mock>).mock.calls
			.length;
		expect(deleteCallCount2).toBeGreaterThan(deleteCallCount1);

		runner.stop();
		sessions[2]?.resolve({ type: "cancelled" });
	});
});

describe("rotation 後のリセット", () => {
	test("rotation 後は delay が 2s にリセットされる", async () => {
		// cap 到達（4回）+ cap 後エラー（ローテーション）+ rotation 後の新エラー
		const sessions = Array.from({ length: 8 }, () => deferred<OpencodeSessionEvent>());
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));

		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1〜4回目のエラー: バックオフで cap 到達
		for (let i = 0; i < 4; i++) {
			sessions[i]?.resolve({ type: "error", message: "err", retryable: true });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
		}

		// 5回目: cap 到達済みなのでローテーション発動、delay はリセットされる
		sessions[4]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const sleepsBefore = sleepValues.length;

		// rotation 後の新エラー → delay は 2s からリスタート
		sessions[5]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const newSleep = sleepValues[sleepsBefore];
		// rotation 後の初回エラーは 2s から再開（10s ではない）
		expect(newSleep).toBe(2000);

		runner.stop();
		sessions[6]?.resolve({ type: "cancelled" });
	});
});

describe("正常復帰後の delay リセット（既存契約維持）", () => {
	test("idle 後のエラーでは delay が 2s にリセットされている", async () => {
		// [0] error → sleep 2s, [1] error → sleep 4s, [2] idle → delay reset,
		// [3] error → sleep 2s (reset確認), [4] pending (runner.stop() 後のガード)
		const sessions = [
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
			deferred<OpencodeSessionEvent>(),
		];
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));

		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラー発生 → sleep 2s
		sessions[0]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラー → sleep 4s
		sessions[1]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 正常復帰 (idle) → delay リセット
		sessions[2]?.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const idleSleepCount = sleepValues.length;

		// idle 後は新しいメッセージが必要（lastPromptText がクリアされるため）
		await runner.send({ sessionKey: "k", message: "test2" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 再エラー → delay は 2s からリスタート
		sessions[3]?.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// idle 後の sleep は IDLE_COOLDOWN_MS (2000) なので、
		// 次のエラー sleep は 2000 から始まる
		const sleepAfterIdle = sleepValues[idleSleepCount];
		expect(sleepAfterIdle).toBe(2000);

		runner.stop();
		sessions[4]?.resolve({ type: "cancelled" });
	});
});

describe("SESSION_RESTARTS reason ラベルの分類", () => {
	test("retryable:true でバックオフ中の再起動は reason=error_retryable_backoff", async () => {
		const session1 = deferred<OpencodeSessionEvent>();
		const session2 = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortWithSessions([session1.promise, session2.promise]);
		const metrics = createMockMetrics();

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		session1.resolve({ type: "error", message: "err", retryable: true });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const restartCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_RESTARTS,
		);
		const backoffRestarts = restartCalls.filter(
			(call: unknown[]) =>
				(call[1] as Record<string, string> | undefined)?.reason === "error_retryable_backoff",
		);
		expect(backoffRestarts.length).toBeGreaterThanOrEqual(1);

		runner.stop();
		session2.resolve({ type: "cancelled" });
	});

	test("retryable:true で cap 到達後の rotation は reason=error_retryable_rotation", async () => {
		const sessions = Array.from({ length: 7 }, () => deferred<OpencodeSessionEvent>());
		const sessionPort = createSessionPortWithSessions(sessions.map((d) => d.promise));
		const metrics = createMockMetrics();

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1〜4回目のエラー (cap到達まで)
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

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const restartCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_RESTARTS,
		);
		const rotationRestarts = restartCalls.filter(
			(call: unknown[]) =>
				(call[1] as Record<string, string> | undefined)?.reason === "error_retryable_rotation",
		);
		expect(rotationRestarts.length).toBeGreaterThanOrEqual(1);

		runner.stop();
		sessions[5]?.resolve({ type: "cancelled" });
	});

	test("retryable:false の即時 rotation は reason=error_non_retryable_rotation", async () => {
		const session1 = deferred<OpencodeSessionEvent>();
		const session2 = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortWithSessions([session1.promise, session2.promise]);
		const metrics = createMockMetrics();

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		session1.resolve({ type: "error", message: "err", retryable: false });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const incrementCalls = (metrics.incrementCounter as ReturnType<typeof mock>).mock.calls;
		const restartCalls = incrementCalls.filter(
			(call: unknown[]) => call[0] === METRIC.SESSION_RESTARTS,
		);
		const nonRetryableRotations = restartCalls.filter(
			(call: unknown[]) =>
				(call[1] as Record<string, string> | undefined)?.reason === "error_non_retryable_rotation",
		);
		expect(nonRetryableRotations.length).toBeGreaterThanOrEqual(1);

		runner.stop();
		session2.resolve({ type: "cancelled" });
	});
});
