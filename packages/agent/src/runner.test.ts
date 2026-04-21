/* oxlint-disable max-lines, max-lines-per-function, max-classes-per-file, no-inline-comments -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { createMockLogger } from "@vicissitude/shared/test-helpers";
import type {
	ContextBuilderPort,
	OpencodeSessionEvent,
	OpencodeSessionPort,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "./profile.ts";
import { AgentRunner, type RunnerDeps } from "./runner.ts";

/** テスト用サブクラス: protected constructor を公開し、sleep をオーバーライド可能にする */
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

	protected override waitForDebounce(_signal: AbortSignal): Promise<void> {
		return Promise.resolve();
	}
}

function deferred<T>() {
	let resolveDeferred!: (value: T) => void;
	let rejectDeferred!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolveDeferred = resolve;
		rejectDeferred = reject;
	});
	return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function createProfile(): AgentProfile {
	return {
		name: "conversation",
		mcpServers: {},
		builtinTools: {},
		pollingPrompt: "loop forever",
		model: { providerId: "test-provider", modelId: "test-model" },
	};
}

function createContextBuilder(): ContextBuilderPort {
	return { build: mock(() => Promise.resolve("system prompt")) };
}

function createSessionStore() {
	let sessionId: string | undefined;
	let createdAt: number | undefined;
	return {
		get: mock(() => sessionId),
		getRow: mock(() => (sessionId && createdAt ? { key: "k", sessionId, createdAt } : undefined)),
		save: mock((_profile: string, _key: string, nextSessionId: string) => {
			sessionId = nextSessionId;
			createdAt = Date.now();
		}),
		delete: mock(() => {
			sessionId = undefined;
			createdAt = undefined;
		}),
	};
}

function createSessionPort(
	promptAsyncAndWatchSessionImpl: () => Promise<OpencodeSessionEvent>,
	waitForSessionIdleImpl?: () => Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & {
	promptAsync: ReturnType<typeof mock>;
	promptAsyncAndWatchSession: ReturnType<typeof mock>;
	waitForSessionIdle: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock((_params, _signal) => promptAsyncAndWatchSessionImpl()),
		waitForSessionIdle: mock(waitForSessionIdleImpl ?? promptAsyncAndWatchSessionImpl),
		summarizeSession: mock(() => Promise.resolve()),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	};
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

describe("AgentRunner", () => {
	test("初回メッセージ送信後に long-lived session を起動し、idle を待たずに稼働し続ける", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// send() でメッセージをキューに入れると ensurePolling が自動起動する
		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(sessionPort.waitForSessionIdle).toHaveBeenCalledTimes(0);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("session が idle になったら新規メッセージ待ちで再起動する", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let sessionWatchCount = 0;
		const watchImpl = () => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		};
		const sessionPort = createSessionPort(watchImpl);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);

		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// idle 後は waitForMessages で次のメッセージを待つ。2つ目のメッセージを送る
		await runner.send({ sessionKey: "k", message: "test2" });
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("起動準備中に stop されても abort 不能な監視セッションを開始しない", async () => {
		const buildDeferred = deferred<string>();
		const sessionPort = createSessionPort(() => Promise.resolve({ type: "idle" }));
		const contextBuilder: ContextBuilderPort = { build: mock(() => buildDeferred.promise) };
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder,
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// send() でメッセージをキューに入れてポーリング起動
		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		runner.stop();
		buildDeferred.resolve("system prompt");
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(0);
	});

	test("idle 後にクールダウン待機が入り、ビジーループしない", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);

		// セッションが idle になる
		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// idle 後に次のセッション開始前にクールダウン sleep が呼ばれるべき
		expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
		expect(sleepCalls[0]).toBeGreaterThan(0);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("error 後のバックオフは既存の指数バックオフ動作を維持する", async () => {
		const errors = [new Error("session error 1"), new Error("session error 2")] as const;
		let sessionWatchCount = 0;
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			if (sessionWatchCount === 1) {
				return Promise.reject(errors[0]);
			}
			if (sessionWatchCount === 2) {
				return Promise.reject(errors[1]);
			}
			return thirdSessionDone.promise;
		});

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		// エラー1回目 → sleep → エラー2回目 → sleep → 3回目セッション開始
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// error 後は指数バックオフで sleep が呼ばれる
		expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
		// 初回 delay = 2000, 2回目 = 4000 (倍増)
		expect(sleepCalls[0]).toBe(2000);
		expect(sleepCalls[1]).toBe(4000);

		runner.stop();
		thirdSessionDone.resolve({ type: "cancelled" });
	});

	test("requestSessionRotation: セッションが存在する場合 deleteSession → sessionStore.delete が呼ばれる", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// セッションを事前に保存
		sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

		await runner.requestSessionRotation();

		expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-abc");
		expect(sessionStore.delete).toHaveBeenCalledTimes(1);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("requestSessionRotation: セッションが存在しない場合は何もしない", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		await runner.requestSessionRotation();

		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(0);
		expect(sessionStore.delete).toHaveBeenCalledTimes(0);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("forceSessionRotation: minRotationIntervalMs 以内でも実行される", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

		// 1回目（force=false / デフォルト）
		await runner.requestSessionRotation();
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(1);

		// 再度セッションを保存
		sessionStore.save("conversation", "__polling__:guild-1", "session-def");

		// minRotationIntervalMs 以内だが forceSessionRotation → スキップしない
		await runner.forceSessionRotation();
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(2);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("requestSessionRotation: minRotationIntervalMs 以内の連続呼び出しは無視される", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

		await runner.requestSessionRotation();
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(1);

		// 再度セッションを保存して2回目を呼ぶ
		sessionStore.save("conversation", "__polling__:guild-1", "session-def");
		await runner.requestSessionRotation();
		// minRotationIntervalMs 以内なので無視される
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(1);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("requestSessionRotation: deleteSession がエラーを投げても sessionStore.delete は呼ばれクラッシュしない", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => sessionDone.promise);
		sessionPort.deleteSession = mock(() => Promise.reject(new Error("API error")));
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

		// エラーが投げられてもクラッシュしない
		await runner.requestSessionRotation();

		expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-abc");
		expect(sessionStore.delete).toHaveBeenCalledTimes(1);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("compacted 後、waitForMessages を挟まず waitForSessionIdle が即座に呼ばれる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(
			() => firstSessionDone.promise,
			() => {
				sessionWatchCount += 1;
				return sessionWatchCount === 1
					? secondSessionDone.promise
					: deferred<OpencodeSessionEvent>().promise;
			},
		);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);

		// compacted イベントを発火
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// waitForSessionIdle が呼ばれる（waitForMessages は挟まない）
		expect(sessionPort.waitForSessionIdle).toHaveBeenCalledTimes(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("compacted 後に delay が INITIAL_RECONNECT_DELAY_MS にリセットされる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(
			() => firstSessionDone.promise,
			() => {
				sessionWatchCount += 1;
				return sessionWatchCount === 1 ? secondSessionDone.promise : thirdSessionDone.promise;
			},
		);

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		// compacted → delay リセット
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted 後に error が起きた場合、delay は INITIAL (2000) から始まるべき
		secondSessionDone.reject(new Error("session error after compaction"));
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sleepCalls[0]).toBe(2000);

		runner.stop();
		thirdSessionDone.resolve({ type: "cancelled" });
	});

	test("compacted 後に rotateSessionIfExpired がスキップされる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(
			() => firstSessionDone.promise,
			() => secondSessionDone.promise,
		);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			// sessionMaxAgeMs を 0 にしてセッション期限切れを強制
			sessionMaxAgeMs: 0,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		// compacted イベントを発火
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// rotateSessionIfExpired はスキップされるため、deleteSession は呼ばれない
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(0);
		// セッションは再監視されている
		expect(sessionPort.waitForSessionIdle).toHaveBeenCalledTimes(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("rewatchSession: sessionStore に sessionId がない場合 warn ログを出力して何もしない", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let promptAsyncCount = 0;
		const sessionPort = createSessionPort(
			() => {
				promptAsyncCount += 1;
				return promptAsyncCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
			},
			() => deferred<OpencodeSessionEvent>().promise,
		);

		const sessionStore = createSessionStore();
		const logger = createMockLogger();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger,
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		// セッションが作成された後、store から削除して compacted を発火
		sessionStore.delete();
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// warn ログが出力される
		expect(logger.warn).toHaveBeenCalledTimes(1);
		// waitForSessionIdle は呼ばれない（rewatchSession が早期リターン）
		expect(sessionPort.waitForSessionIdle).toHaveBeenCalledTimes(0);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("deleted イベント受信時に SESSION_RESTARTS が reason=session_deleted_rotation でインクリメントされる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});
		const sessionStore = createSessionStore();
		const metrics = {
			incrementCounter: mock(() => {}),
			addCounter: mock(() => {}),
			setGauge: mock(() => {}),
			incrementGauge: mock(() => {}),
			decrementGauge: mock(() => {}),
			observeHistogram: mock(() => {}),
		};

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
			metrics,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		// deleted イベント発火
		firstSessionDone.resolve({ type: "deleted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// session_restarts_total メトリクスが reason=session_deleted_rotation で呼ばれている
		expect(metrics.incrementCounter).toHaveBeenCalledWith("session_restarts_total", {
			reason: "session_deleted_rotation",
		});

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("deleted イベント受信時に forceSessionRotation が呼ばれる（throttle 回避）", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});
		const sessionStore = createSessionStore();

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		const rotationSpy = mock(() => Promise.resolve());
		runner.forceSessionRotation = rotationSpy;
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "deleted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// forceSessionRotation が呼ばれている
		expect(rotationSpy).toHaveBeenCalledTimes(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("handleSessionEnd: deleted イベントで warn ログが出力される", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});
		const logger = createMockLogger();

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger,
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		// forceSessionRotation をモックして副作用を止める（warn ログ検証のノイズを減らす）
		runner.forceSessionRotation = mock(() => Promise.resolve());
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "deleted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// "deleted externally" を含む warn ログが出ている
		const warnMessages = logger.warn.mock.calls.map((args) => String(args[0])).join("\n");
		expect(warnMessages).toContain("deleted externally");
		// error ログは出ていない
		expect(logger.error).toHaveBeenCalledTimes(0);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("deleted 後に delay が INITIAL_RECONNECT_DELAY_MS にリセットされる", async () => {
		// deleted → rotation → 次の error で backoff が 2s から始まることを確認
		let sessionWatchCount = 0;
		const lastSession = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			if (sessionWatchCount === 1) {
				// まず error を何度か経験させて delay を膨らませる
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			if (sessionWatchCount === 2) {
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			if (sessionWatchCount === 3) {
				// deleted で delay リセット
				return Promise.resolve({ type: "deleted" as const });
			}
			if (sessionWatchCount === 4) {
				// リセット確認用の error
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			return lastSession.promise;
		});

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		// forceSessionRotation はスタブ化（実際の delete 等の副作用を止める）
		runner.forceSessionRotation = mock(() => Promise.resolve());
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		for (let i = 0; i < 30; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Bun.sleep(0);
		}

		// error×2 で sleep が 2000, 4000 と進み、deleted 後の error では 2000 に戻る
		expect(sleepCalls[0]).toBe(2000);
		expect(sleepCalls[1]).toBe(4000);
		// deleted 後の最初の error 時の sleep は INITIAL に戻っている
		expect(sleepCalls[2]).toBe(2000);

		runner.stop();
		lastSession.resolve({ type: "cancelled" });
	});

	test("send() はポーリングループが未起動なら自動起動する", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// send() を呼ぶとポーリングが自動起動し、メッセージがキューに入る
		await runner.send({ sessionKey: "test", message: "hello" });

		// promptAsyncAndWatchSession が呼ばれている（ポーリング起動済み）
		await Bun.sleep(0);
		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// バックオフ・ローテーション戦略の内部ロジック（ホワイトボックス）
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentRunner バックオフ・ローテーション戦略（内部ロジック）", () => {
	test("error イベント（retryable:true）で sleep 数列が 2s→4s→8s→10s になる", async () => {
		let sessionWatchCount = 0;
		const lastSession = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			// 4 回エラー → cap 到達後に 5 回目エラー → rotation → lastSession
			if (sessionWatchCount <= 4) {
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			if (sessionWatchCount === 5) {
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			return lastSession.promise;
		});

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		// 5 回のエラー + ローテーション分の非同期ステップを消化
		for (let i = 0; i < 30; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Bun.sleep(0);
		}

		// バックオフ数列: 2000 → 4000 → 8000 → 10000
		expect(sleepCalls[0]).toBe(2000);
		expect(sleepCalls[1]).toBe(4000);
		expect(sleepCalls[2]).toBe(8000);
		expect(sleepCalls[3]).toBe(10000);

		runner.stop();
		lastSession.resolve({ type: "cancelled" });
	});

	test("例外（throw）時も retryable:true 扱いでバックオフ delay が増加する", async () => {
		let sessionWatchCount = 0;
		const thirdSession = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			if (sessionWatchCount === 1) return Promise.reject(new Error("thrown error 1"));
			if (sessionWatchCount === 2) return Promise.reject(new Error("thrown error 2"));
			return thirdSession.promise;
		});

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		for (let i = 0; i < 10; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Bun.sleep(0);
		}

		// 例外時も指数バックオフ: 2000 → 4000
		expect(sleepCalls[0]).toBe(2000);
		expect(sleepCalls[1]).toBe(4000);

		runner.stop();
		thirdSession.resolve({ type: "cancelled" });
	});

	test("retryable:false エラー後は delay が 2s にリセットされる（後続エラーでバックオフが 2s から始まる）", async () => {
		let sessionWatchCount = 0;
		const lastSession = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			if (sessionWatchCount === 1) {
				return Promise.resolve({
					type: "error",
					message: "non-retryable",
					retryable: false as const,
				});
			}
			if (sessionWatchCount === 2) {
				return Promise.resolve({ type: "error", message: "retryable", retryable: true as const });
			}
			return lastSession.promise;
		});

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		for (let i = 0; i < 20; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Bun.sleep(0);
		}

		// retryable:false は sleep なし（sleepCalls に 2000 以上のものは入らないはず）
		// 続くretryable:true エラーでは delay が 2s からリスタート
		const longSleeps = sleepCalls.filter((ms) => ms >= 2000);
		// retryable:false のローテーション後の最初のバックオフが 2000 であること
		if (longSleeps.length > 0) {
			expect(longSleeps[0]).toBe(2000);
		}

		runner.stop();
		lastSession.resolve({ type: "cancelled" });
	});

	test("prevSleepWasCapped リセット: idle 後の次のエラーで prevSleepWasCapped が false に戻る", async () => {
		// idle が来た後は prevSleepWasCapped がリセットされ、
		// cap 到達からのローテーションが再び必要な回数 error を重ねないと発動しないことを確認
		let sessionWatchCount = 0;
		const lastSession = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			// 1〜4 回目: error (cap 到達) → 5 回目: cap 後エラー → rotation発動
			// 6 回目: idle (delay/prevSleepWasCapped リセット)
			// 7 回目: error (2s から再開)
			if (sessionWatchCount <= 4) {
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			if (sessionWatchCount === 5) {
				// cap 後エラー → rotation → delay リセット
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			if (sessionWatchCount === 6) {
				return Promise.resolve({ type: "idle" });
			}
			if (sessionWatchCount === 7) {
				return Promise.resolve({ type: "error", message: "err", retryable: true as const });
			}
			return lastSession.promise;
		});

		const sleepCalls: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		for (let i = 0; i < 50; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Bun.sleep(0);
		}

		// idle 後に再エラーが来たとき、sleepCalls の末尾付近が 2000 であること
		// （cap のまま 10000 が来ていないことを確認）
		const lastSleep = sleepCalls.at(-1);
		// idle 後の最初のバックオフは 2s（cap に達していない）
		expect(lastSleep).toBe(2000);

		runner.stop();
		lastSession.resolve({ type: "cancelled" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// セッション要約生成の内部ロジック（ホワイトボックス）
// raceAbort / abortReasonToError / generateSessionSummary / summaryTimeoutMs DI
// ─────────────────────────────────────────────────────────────────────────────

/** summaryPrompt 付きプロファイル（内部ロジック検証用） */
function createProfileWithSummary(): AgentProfile {
	return {
		...createProfile(),
		summaryPrompt: "要約してください",
	};
}

/** rotation を単発で呼ぶためのシンプルな sessionPort（ポーリングループは起動しない） */
function createSimpleSessionPort(
	promptImpl: (signal?: AbortSignal) => Promise<{ text: string; tokens: undefined }>,
): OpencodeSessionPort & {
	prompt: ReturnType<typeof mock>;
	deleteSession: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock((_params: unknown, signal?: AbortSignal) => promptImpl(signal)),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & {
		prompt: ReturnType<typeof mock>;
		deleteSession: ReturnType<typeof mock>;
	};
}

describe("AgentRunner セッション要約生成の内部ロジック（ホワイトボックス）", () => {
	describe("raceAbort ヘルパー（generateSessionSummary 経由で観察）", () => {
		test("promise が先に resolve したら resolve 値を使って summaryWriter.write が呼ばれる", async () => {
			const sessionPort = createSimpleSessionPort(() =>
				Promise.resolve({ text: "summarized", tokens: undefined }),
			);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				summaryTimeoutMs: 5_000,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			expect(summaryWriter.write).toHaveBeenCalledWith("g1", "summarized");
		});

		test("signal が先に abort したら abort reason で reject される（logger.warn が呼ばれる）", async () => {
			// prompt は永久に pending のまま → timeout 側の signal が先に abort する
			const sessionPort = createSimpleSessionPort(() => new Promise(() => {}));
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				// 短いタイムアウトで raceAbort の signal 先行を誘発
				summaryTimeoutMs: 20,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			// summaryWriter.write は呼ばれず、logger.warn でハンドリング
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(logger.warn).toHaveBeenCalled();
			// logger.error ではないこと（AbortError/TimeoutError は warn 扱い）
			expect(logger.error).toHaveBeenCalledTimes(0);
		});

		test("abortController.signal が事前に aborted なら prompt は呼ばれず早期 return する", async () => {
			const sessionPort = createSimpleSessionPort(() =>
				Promise.resolve({ text: "ok", tokens: undefined }),
			);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				summaryTimeoutMs: 5_000,
			});
			activeRunners.add(runner);

			// abortController を生成させる（ensurePolling 経由）
			runner.ensurePolling();
			await Bun.sleep(0);

			// abortController.signal を abort 済みにする（stop() は使わず、null 化しないことで
			// generateSessionSummary の `if (this.abortController?.signal.aborted) return;` を発火させる）
			// @ts-expect-error -- private フィールド。ホワイトボックステストのため許容
			const ac = runner.abortController as AbortController;
			ac.abort();

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			// generateSessionSummary 冒頭の早期 return により prompt は呼ばれない
			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			// ただし rotation 本体は完遂（deleteSession / sessionStore.delete は呼ばれる）
			expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-abc");
		});

		test("raceAbort の finally で abort listener が removeEventListener される（メモリリークしない）", async () => {
			// AbortSignal.timeout をモンキーパッチして、返された signal の
			// addEventListener / removeEventListener をスパイでラップする。
			// 成功パスでは raceAbort の addEventListener と finally の removeEventListener が
			// ペアで呼ばれるはず（listener が外れないとリーク）。
			//
			// abortController が null の状態（ensurePolling 未呼び出し）では
			// combinedSignal = timeoutSignal となり、raceAbort は timeoutSignal に直接
			// addEventListener("abort", ...) を呼ぶ。
			const origTimeout = AbortSignal.timeout.bind(AbortSignal);
			const addAbortCount = { n: 0 };
			const removeAbortCount = { n: 0 };
			AbortSignal.timeout = ((ms: number) => {
				const s = origTimeout(ms);
				const origAdd = s.addEventListener.bind(s);
				const origRemove = s.removeEventListener.bind(s);
				s.addEventListener = ((type: string, ...rest: unknown[]) => {
					if (type === "abort") addAbortCount.n += 1;
					return (origAdd as unknown as (...args: unknown[]) => void)(type, ...rest);
				}) as typeof s.addEventListener;
				s.removeEventListener = ((type: string, ...rest: unknown[]) => {
					if (type === "abort") removeAbortCount.n += 1;
					return (origRemove as unknown as (...args: unknown[]) => void)(type, ...rest);
				}) as typeof s.removeEventListener;
				return s;
			}) as typeof AbortSignal.timeout;

			try {
				const sessionPort = createSimpleSessionPort(() =>
					Promise.resolve({ text: "ok", tokens: undefined }),
				);
				const summaryWriter = { write: mock(() => Promise.resolve()) };
				const sessionStore = createSessionStore();

				const runner = new TestAgent({
					profile: createProfileWithSummary(),
					agentId: "guild-1",
					sessionStore: sessionStore as never,
					contextBuilder: createContextBuilder(),
					logger: createMockLogger(),
					sessionPort: sessionPort as unknown as OpencodeSessionPort,
					sessionMaxAgeMs: 3_600_000,
					contextGuildId: "g1",
					summaryWriter,
					summaryTimeoutMs: 5_000,
				});
				activeRunners.add(runner);

				// ensurePolling は呼ばない → abortController は null → combinedSignal = timeoutSignal
				sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
				await runner.forceSessionRotation();

				// 成功パスでは:
				// 1. raceAbort が addEventListener("abort", ...) を 1 回呼ぶ
				// 2. 成功して finally で removeEventListener を 1 回呼ぶ
				expect(addAbortCount.n).toBeGreaterThanOrEqual(1);
				expect(removeAbortCount.n).toBe(addAbortCount.n);
				expect(summaryWriter.write).toHaveBeenCalledTimes(1);
			} finally {
				AbortSignal.timeout = origTimeout;
			}
		});
	});

	describe("abortReasonToError の正規化（logger メッセージから観察）", () => {
		test("AbortSignal.timeout 由来の TimeoutError が保たれ、logger.warn に TimeoutError が含まれる", async () => {
			// prompt を永久 pending にして timeout 側から打ち切らせる
			const sessionPort = createSimpleSessionPort(() => new Promise(() => {}));
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				summaryTimeoutMs: 20,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			// logger.warn の第1引数（メッセージ文字列）に TimeoutError が含まれるはず
			const warnMessages = logger.warn.mock.calls.map((args) => String(args[0])).join("\n");
			expect(warnMessages).toContain("TimeoutError");
			expect(logger.error).toHaveBeenCalledTimes(0);
		});

		test("AbortController.abort() (reason 未設定) では AbortError に正規化され logger.warn が呼ばれる", async () => {
			// prompt を pending のままにして、runner 側の abortController を手動 abort させる。
			// AbortController.abort() は reason 未指定のため DOMException("AbortError") になる。
			const promptDeferred = deferred<{ text: string; tokens: undefined }>();
			const sessionPort = createSimpleSessionPort(() => promptDeferred.promise);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				// timeout より先に abort が走るよう十分長く
				summaryTimeoutMs: 60_000,
			});
			activeRunners.add(runner);

			// abortController を生成させるために ensurePolling → 即 stop
			runner.ensurePolling();
			await Bun.sleep(0);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			const rotationPromise = runner.forceSessionRotation();
			// prompt 呼び出しが走るのを待つ
			await Bun.sleep(0);

			// runner.stop() → abortController.abort() により signal が abort される
			runner.stop();
			await rotationPromise;

			const warnMessages = logger.warn.mock.calls.map((args) => String(args[0])).join("\n");
			expect(warnMessages).toContain("AbortError");
			expect(logger.error).toHaveBeenCalledTimes(0);
		});
	});

	describe("generateSessionSummary の内部分岐", () => {
		test("早期 return: summaryWriter 未設定なら prompt は呼ばれない", async () => {
			const sessionPort = createSimpleSessionPort(() =>
				Promise.resolve({ text: "ok", tokens: undefined }),
			);
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				// summaryWriter は未設定
				summaryTimeoutMs: 5_000,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			// rotation 本体は完遂する
			expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-abc");
		});

		test("早期 return: contextGuildId 未設定なら prompt は呼ばれない", async () => {
			const sessionPort = createSimpleSessionPort(() =>
				Promise.resolve({ text: "ok", tokens: undefined }),
			);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				// contextGuildId 未設定
				summaryWriter,
				summaryTimeoutMs: 5_000,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
		});

		test("早期 return: profile.summaryPrompt 未設定なら prompt は呼ばれない", async () => {
			const sessionPort = createSimpleSessionPort(() =>
				Promise.resolve({ text: "ok", tokens: undefined }),
			);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				// summaryPrompt 無しの通常プロファイル
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				summaryTimeoutMs: 5_000,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
		});

		test("text が空白のみなら summaryWriter.write は呼ばれない", async () => {
			const sessionPort = createSimpleSessionPort(() =>
				Promise.resolve({ text: "   \n  ", tokens: undefined }),
			);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				summaryTimeoutMs: 5_000,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
		});

		test("非 Abort/Timeout の例外は logger.error で記録される（既存契約維持）", async () => {
			const sessionPort = createSimpleSessionPort(() =>
				Promise.reject(new Error("some runtime error")),
			);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				summaryTimeoutMs: 5_000,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			await runner.forceSessionRotation();

			expect(logger.error).toHaveBeenCalled();
			// warn ではなく error 側
			const warnTimeoutCalls = logger.warn.mock.calls.filter((args) =>
				String(args[0]).includes("session summary aborted"),
			);
			expect(warnTimeoutCalls.length).toBe(0);
		});

		test("AbortSignal.any 合成: abortController 側が先に abort しても logger.warn で AbortError 扱いになる", async () => {
			// summaryTimeoutMs を十分長くし、runner.stop() を先に走らせて
			// abortController 側が先に打ち切ることを確認する（timeoutSignal と合成した signal の動作検証）。
			const promptDeferred = deferred<{ text: string; tokens: undefined }>();
			const sessionPort = createSimpleSessionPort(() => promptDeferred.promise);
			const summaryWriter = { write: mock(() => Promise.resolve()) };
			const sessionStore = createSessionStore();
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfileWithSummary(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "g1",
				summaryWriter,
				summaryTimeoutMs: 60_000,
			});
			activeRunners.add(runner);

			runner.ensurePolling();
			await Bun.sleep(0);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
			const rotationPromise = runner.forceSessionRotation();
			await Bun.sleep(0);

			runner.stop();
			await rotationPromise;

			// AbortError 側での warn が記録されている
			const warnMessages = logger.warn.mock.calls.map((args) => String(args[0])).join("\n");
			expect(warnMessages).toContain("session summary aborted");
			expect(warnMessages).toContain("AbortError");
		});
	});

	describe("summaryTimeoutMs の DI", () => {
		test("未指定時は DEFAULT_SUMMARY_TIMEOUT_MS (30_000) が AbortSignal.timeout に渡される", async () => {
			// AbortSignal.timeout をモンキーパッチして呼び出し時の ms を記録する
			const timeoutCalls: number[] = [];
			const origTimeout = AbortSignal.timeout.bind(AbortSignal);
			AbortSignal.timeout = ((ms: number) => {
				timeoutCalls.push(ms);
				return origTimeout(ms);
			}) as typeof AbortSignal.timeout;

			try {
				const sessionPort = createSimpleSessionPort(() =>
					Promise.resolve({ text: "ok", tokens: undefined }),
				);
				const summaryWriter = { write: mock(() => Promise.resolve()) };
				const sessionStore = createSessionStore();

				const runner = new TestAgent({
					profile: createProfileWithSummary(),
					agentId: "guild-1",
					sessionStore: sessionStore as never,
					contextBuilder: createContextBuilder(),
					logger: createMockLogger(),
					sessionPort: sessionPort as unknown as OpencodeSessionPort,
					sessionMaxAgeMs: 3_600_000,
					contextGuildId: "g1",
					summaryWriter,
					// summaryTimeoutMs 未指定
				});
				activeRunners.add(runner);

				sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
				await runner.forceSessionRotation();

				expect(timeoutCalls).toContain(30_000);
			} finally {
				AbortSignal.timeout = origTimeout;
			}
		});

		test("指定時は渡された値が AbortSignal.timeout に使われる", async () => {
			const timeoutCalls: number[] = [];
			const origTimeout = AbortSignal.timeout.bind(AbortSignal);
			AbortSignal.timeout = ((ms: number) => {
				timeoutCalls.push(ms);
				return origTimeout(ms);
			}) as typeof AbortSignal.timeout;

			try {
				const sessionPort = createSimpleSessionPort(() =>
					Promise.resolve({ text: "ok", tokens: undefined }),
				);
				const summaryWriter = { write: mock(() => Promise.resolve()) };
				const sessionStore = createSessionStore();

				const runner = new TestAgent({
					profile: createProfileWithSummary(),
					agentId: "guild-1",
					sessionStore: sessionStore as never,
					contextBuilder: createContextBuilder(),
					logger: createMockLogger(),
					sessionPort: sessionPort as unknown as OpencodeSessionPort,
					sessionMaxAgeMs: 3_600_000,
					contextGuildId: "g1",
					summaryWriter,
					summaryTimeoutMs: 12_345,
				});
				activeRunners.add(runner);

				sessionStore.save("conversation", "__polling__:guild-1", "session-abc");
				await runner.forceSessionRotation();

				expect(timeoutCalls).toContain(12_345);
				expect(timeoutCalls).not.toContain(30_000);
			} finally {
				AbortSignal.timeout = origTimeout;
			}
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// デバウンス機構の内部ロジック（ホワイトボックス）
// waitForDebounce / raceDebounce / pendingDebounceResolve
// ─────────────────────────────────────────────────────────────────────────────

/** デバウンス有効のテスト用サブクラス: sleep を制御可能にしつつ waitForDebounce を実行する */
class DebounceTestAgent extends AgentRunner {
	sleepSpy: ((ms: number) => Promise<void>) | null = null;

	// oxlint-disable-next-line no-useless-constructor -- protected → public に昇格させるために必要
	constructor(deps: RunnerDeps) {
		super(deps);
	}

	protected override sleep(ms: number): Promise<void> {
		if (this.sleepSpy) return this.sleepSpy(ms);
		return super.sleep(ms);
	}

	/** waitForDebounce を public に昇格して直接テスト可能にする */
	public callWaitForDebounce(signal: AbortSignal): Promise<void> {
		return this.waitForDebounce(signal);
	}

	/** ensurePolling を無効化してポーリングループが走らないようにする */
	override ensurePolling(): void {
		// no-op: debounce テストではポーリングループを起動しない
	}
}

describe("AgentRunner デバウンス機構（内部ロジック）", () => {
	test("新メッセージが来なければ MESSAGE_DEBOUNCE_MS (2000ms) の sleep 後にデバウンス完了する", async () => {
		const sleepCalls: number[] = [];
		const sleepDeferreds: Array<{ resolve: () => void }> = [];
		const runner = new DebounceTestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSessionPort(() => deferred<OpencodeSessionEvent>().promise),
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => 0,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			const d = deferred<void>();
			sleepDeferreds.push({ resolve: d.resolve });
			return d.promise;
		};
		activeRunners.add(runner);

		// メッセージを1つ入れておく（pendingMessages.length > 0）
		await runner.send({ sessionKey: "k", message: "msg1" });

		const ac = new AbortController();
		const debouncePromise = runner.callWaitForDebounce(ac.signal);

		// sleep(2000) が呼ばれる
		await Bun.sleep(0);
		expect(sleepCalls).toEqual([2000]);

		// sleep を resolve → pendingMessages が変わっていないのでデバウンス完了
		sleepDeferreds.at(0)?.resolve();
		await debouncePromise;

		runner.stop();
	});

	test("send() が pendingDebounceResolve を呼び、sleep が中断されてタイマーがリセットされる", async () => {
		const sleepCalls: number[] = [];
		const sleepDeferreds: Array<{ resolve: () => void }> = [];
		let now = 0;
		const runner = new DebounceTestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSessionPort(() => deferred<OpencodeSessionEvent>().promise),
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => now,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			const d = deferred<void>();
			sleepDeferreds.push({ resolve: d.resolve });
			return d.promise;
		};
		activeRunners.add(runner);

		// メッセージを1つ入れておく
		await runner.send({ sessionKey: "k", message: "msg1" });

		const ac = new AbortController();
		const debouncePromise = runner.callWaitForDebounce(ac.signal);
		await Bun.sleep(0);

		// 最初の sleep(2000) が呼ばれている
		expect(sleepCalls.length).toBe(1);
		expect(sleepCalls[0]).toBe(2000);

		// 新メッセージ送信 → pendingDebounceResolve が呼ばれて race が解決する
		await runner.send({ sessionKey: "k", message: "msg2" });

		// raceDebounce が解決し、pendingMessages が増えたのでループ継続 → 次の sleep が呼ばれる
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(sleepCalls.length).toBe(2);
		expect(sleepCalls[1]).toBe(2000); // タイマーリセット: 再び 2000ms

		// 2回目の sleep を resolve → メッセージが来ていないのでデバウンス完了
		sleepDeferreds.at(1)?.resolve();
		await debouncePromise;

		runner.stop();
	});

	test("nowProvider で deadline 超過を再現: MAX_DEBOUNCE_MS を超えるとループ終了する", async () => {
		const sleepCalls: number[] = [];
		let now = 0;
		let loopCount = 0;
		const runner = new DebounceTestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSessionPort(() => deferred<OpencodeSessionEvent>().promise),
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => now,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			now += ms;
			loopCount += 1;
			// deadline に近づくまでメッセージを追加し続ける
			if (now < 10000) {
				void runner.send({ sessionKey: "k", message: `msg-loop-${loopCount}` });
			}
			return Promise.resolve();
		};
		activeRunners.add(runner);

		// メッセージを入れておく
		await runner.send({ sessionKey: "k", message: "msg1" });

		// now=0, deadline=10000
		// ループ内: sleep(2000) → now=2000, メッセージ追加 → ループ継続
		// sleep(2000) → now=4000, メッセージ追加 → ループ継続
		// ...
		// sleep(2000) → now=10000, メッセージ追加なし → remaining<=0 で break
		await runner.callWaitForDebounce(new AbortController().signal);

		// MAX_DEBOUNCE_MS (10000) の範囲内でループが複数回実行された後に終了
		expect(loopCount).toBeGreaterThanOrEqual(2);
		// 合計時間が MAX_DEBOUNCE_MS (10000) を超えていないことを確認
		const totalSleepMs = sleepCalls.reduce((a, b) => a + b, 0);
		expect(totalSleepMs).toBeLessThanOrEqual(10000);

		runner.stop();
	});

	test("abort signal が発火するとデバウンスが即座に終了する", async () => {
		const sleepCalls: number[] = [];
		const runner = new DebounceTestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSessionPort(() => deferred<OpencodeSessionEvent>().promise),
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => 0,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			// sleep は resolve しない（abort で打ち切られることを期待）
			return new Promise(() => {});
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "msg1" });

		const ac = new AbortController();
		const debouncePromise = runner.callWaitForDebounce(ac.signal);
		await Bun.sleep(0);

		// sleep が開始されている
		expect(sleepCalls.length).toBe(1);

		// abort → raceDebounce の abortPromise が解決
		ac.abort();
		await debouncePromise;

		// abort 後にデバウンスが正常に終了した（追加の sleep は呼ばれていない）
		expect(sleepCalls.length).toBe(1);

		runner.stop();
	});

	test("remaining が MESSAGE_DEBOUNCE_MS より短い場合、waitMs は remaining にクランプされる", async () => {
		const sleepCalls: number[] = [];
		let now = 0;
		let sendCount = 0;
		const runner = new DebounceTestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSessionPort(() => deferred<OpencodeSessionEvent>().promise),
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => now,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			// 毎回 now を大きく進めて remaining を小さくする
			now += 9000;
			sendCount += 1;
			if (sendCount <= 2) {
				void runner.send({ sessionKey: "k", message: `msg-${sendCount}` });
			}
			return Promise.resolve();
		};
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "msg-start" });

		// now=0, deadline=10000
		// 1回目: remaining=10000, waitMs=min(2000,10000)=2000, now→9000, msg追加
		// 2回目: remaining=10000-9000=1000, waitMs=min(2000,1000)=1000, now→18000, msg追加
		// 3回目: remaining=10000-18000<0 → break
		await runner.callWaitForDebounce(new AbortController().signal);

		expect(sleepCalls[0]).toBe(2000);
		expect(sleepCalls[1]).toBe(1000); // remaining にクランプされた
		expect(sleepCalls.length).toBe(2); // deadline 超過で 3回目は呼ばれない

		runner.stop();
	});
});
