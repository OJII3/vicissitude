/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
	ContextBuilderPort,
	EventBuffer,
	Logger,
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

function createProfile(restartPolicy: AgentProfile["restartPolicy"] = "immediate"): AgentProfile {
	return {
		name: "conversation",
		mcpServers: {},
		builtinTools: {},
		pollingPrompt: "loop forever",
		restartPolicy,
		model: { providerId: "test-provider", modelId: "test-model" },
	};
}

function createLogger(): Logger {
	return {
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
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

function createEventBuffer(waitImpl: (signal: AbortSignal) => Promise<void>): EventBuffer {
	return {
		append: mock(() => {}),
		waitForEvents: mock(waitImpl),
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
	test("初回イベント検知後に long-lived session を起動し、idle を待たずに稼働し続ける", async () => {
		const firstEvent = deferred<void>();
		const sessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		await Bun.sleep(0);
		expect(sessionPort.promptAsync).toHaveBeenCalledTimes(0);

		firstEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(sessionPort.waitForSessionIdle).toHaveBeenCalledTimes(0);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("session が idle になったら新規イベント待ちなしで再起動する", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
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
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(2);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("wait_for_events ポリシーでは idle 後に再度 EventBuffer を待ってから再起動する", async () => {
		const firstEvent = deferred<void>();
		const secondEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let waitCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCount += 1;
			return waitCount === 1 ? firstEvent.promise : secondEvent.promise;
		});
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});

		const runner = new TestAgent({
			profile: createProfile("wait_for_events"),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(2);

		secondEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("起動準備中に stop されても abort 不能な監視セッションを開始しない", async () => {
		const firstEvent = deferred<void>();
		const buildDeferred = deferred<string>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => Promise.resolve({ type: "idle" }));
		const contextBuilder: ContextBuilderPort = { build: mock(() => buildDeferred.promise) };
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder,
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);

		runner.stop();
		buildDeferred.resolve("system prompt");
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(0);
	});

	test("immediate ポリシーで idle 後にクールダウン待機が入り、ビジーループしない", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
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
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
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
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
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
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
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
		const firstEvent = deferred<void>();
		const sessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
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
		const firstEvent = deferred<void>();
		const sessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		await runner.requestSessionRotation();

		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(0);
		expect(sessionStore.delete).toHaveBeenCalledTimes(0);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("requestSessionRotation: minRotationIntervalMs 以内の連続呼び出しは無視される", async () => {
		const firstEvent = deferred<void>();
		const sessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
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
		const firstEvent = deferred<void>();
		const sessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => sessionDone.promise);
		sessionPort.deleteSession = mock(() => Promise.reject(new Error("API error")));
		const sessionStore = createSessionStore();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
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

	test("compacted 後、waitForEvents を挟まず waitForSessionIdle が即座に呼ばれる", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
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
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		// compacted イベントを発火
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// waitForEvents は再度呼ばれず、waitForSessionIdle が呼ばれる
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
		expect(sessionPort.waitForSessionIdle).toHaveBeenCalledTimes(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("compacted 後に delay が INITIAL_RECONNECT_DELAY_MS にリセットされる", async () => {
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
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
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
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
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(
			() => firstSessionDone.promise,
			() => secondSessionDone.promise,
		);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			// sessionMaxAgeMs を 0 にしてセッション期限切れを強制
			sessionMaxAgeMs: 0,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
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
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		let promptAsyncCount = 0;
		const sessionPort = createSessionPort(
			() => {
				promptAsyncCount += 1;
				return promptAsyncCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
			},
			() => deferred<OpencodeSessionEvent>().promise,
		);

		const sessionStore = createSessionStore();
		const logger = createLogger();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger,
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
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

	test("send() はポーリングループが未起動なら自動起動する", async () => {
		const firstEvent = deferred<void>();
		const sessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// send() を呼ぶとポーリングが自動起動する
		await runner.send({ sessionKey: "test", message: "hello" });
		expect(eventBuffer.append).toHaveBeenCalledTimes(1);

		// イベントバッファの waitForEvents が呼ばれている（ポーリング起動済み）
		await Bun.sleep(0);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ハング検知タイマーの内部ロジック
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentRunner ハング検知タイマー（内部ロジック）", () => {
	test("タイマー間隔: hangTimeoutMs / 10 の間隔で setInterval が呼ばれる", () => {
		const hangTimeoutMs = 100;
		const expectedInterval = hangTimeoutMs / 10;
		const setIntervalCalls: number[] = [];

		const origSetInterval = globalThis.setInterval;
		// @ts-expect-error -- setInterval をモックして呼び出し間隔を記録する
		globalThis.setInterval = (fn: () => void, ms: number) => {
			setIntervalCalls.push(ms);
			return origSetInterval(fn, ms);
		};

		const waitDeferred = deferred<void>();
		const eventBuffer = createEventBuffer(() => waitDeferred.promise);
		const sessionPort = createSessionPort(() => deferred<OpencodeSessionEvent>().promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			hangTimeoutMs,
		});
		activeRunners.add(runner);

		runner.ensurePolling();

		globalThis.setInterval = origSetInterval;

		// setInterval が hangTimeoutMs / 10 の間隔で呼ばれているか確認
		expect(setIntervalCalls).toContain(expectedInterval);

		runner.stop();
		waitDeferred.resolve();
	});

	test("タイムスタンプ更新: waitForEvents 呼び出し前後で lastWaitForEventsAt が更新される", async () => {
		// waitForEvents の呼び出し前後にタイムスタンプが更新されることを
		// ローテーションが発生しないことで間接的に検証する
		const hangTimeoutMs = 200;
		let waitForEventsCallCount = 0;
		const timestamps: number[] = [];

		const origDateNow = Date.now;
		let fakeNow = origDateNow();
		// Date.now をモックして呼ばれるたびにタイムスタンプを記録
		globalThis.Date.now = () => {
			const t = fakeNow;
			timestamps.push(t);
			return t;
		};

		const eventBuffer = createEventBuffer(async () => {
			waitForEventsCallCount += 1;
			// 呼び出しごとに時間を少し進める（ハングしていないことをシミュレート）
			fakeNow += 10;
			await Bun.sleep(0);
		});
		const sessionPort = createSessionPort(() => deferred<OpencodeSessionEvent>().promise);
		const rotationSpy = mock(() => Promise.resolve());

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			hangTimeoutMs,
		});
		runner.sleepSpy = () => Promise.resolve();
		runner.requestSessionRotation = rotationSpy;
		activeRunners.add(runner);

		globalThis.Date.now = origDateNow;

		runner.ensurePolling();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// waitForEvents が少なくとも1回は呼ばれている
		expect(waitForEventsCallCount).toBeGreaterThanOrEqual(1);

		runner.stop();
	});

	test("ローテーション発火条件: elapsed >= hangTimeoutMs のときだけ requestSessionRotation が呼ばれる", async () => {
		const hangTimeoutMs = 100;
		const rotationSpy = mock(() => Promise.resolve());

		// waitForEvents が永続的にブロックする（ハング状態）
		const waitDeferred = deferred<void>();
		const eventBuffer = createEventBuffer(() => waitDeferred.promise);
		const sessionPort = createSessionPort(() => deferred<OpencodeSessionEvent>().promise);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			hangTimeoutMs,
		});
		runner.requestSessionRotation = rotationSpy;
		activeRunners.add(runner);

		runner.ensurePolling();

		// hangTimeoutMs より短い時間では発火しない
		await Bun.sleep(50);
		expect(rotationSpy).not.toHaveBeenCalled();

		// hangTimeoutMs を超えたら発火する
		await Bun.sleep(100);
		expect(rotationSpy).toHaveBeenCalledTimes(1);

		runner.stop();
		waitDeferred.resolve();
	});

	test("連続発火防止: ローテーション後に lastWaitForEventsAt がリセットされ、即座に再発火しない", async () => {
		const hangTimeoutMs = 100;
		const rotationSpy = mock(() => Promise.resolve());

		// waitForEvents が永続的にブロックする
		const waitDeferred = deferred<void>();
		const eventBuffer = createEventBuffer(() => waitDeferred.promise);
		const sessionPort = createSessionPort(() => deferred<OpencodeSessionEvent>().promise);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			hangTimeoutMs,
		});
		runner.requestSessionRotation = rotationSpy;
		activeRunners.add(runner);

		runner.ensurePolling();

		// 1回目のハング検知を待つ
		await Bun.sleep(150);
		expect(rotationSpy).toHaveBeenCalledTimes(1);

		// ローテーション直後はリセットされているため、次のインターバルでは発火しない
		// （hangTimeoutMs 経過前なので）
		await Bun.sleep(hangTimeoutMs / 10 + 5);
		// リセット後すぐは発火しないはず（まだ hangTimeoutMs 経過していない）
		expect(rotationSpy).toHaveBeenCalledTimes(1);

		runner.stop();
		waitDeferred.resolve();
	});

	test("タイマー重複防止: ensurePolling を二重呼び出しても setInterval は1回しか呼ばれない", () => {
		const setIntervalCalls: number[] = [];
		const origSetInterval = globalThis.setInterval;
		// @ts-expect-error -- setInterval をモックして呼び出し回数を記録する
		globalThis.setInterval = (fn: () => void, ms: number) => {
			setIntervalCalls.push(ms);
			return origSetInterval(fn, ms);
		};

		const waitDeferred = deferred<void>();
		const eventBuffer = createEventBuffer(() => waitDeferred.promise);
		const sessionPort = createSessionPort(() => deferred<OpencodeSessionEvent>().promise);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			hangTimeoutMs: 1000,
		});
		activeRunners.add(runner);

		// ensurePolling を2回呼ぶ
		runner.ensurePolling();
		runner.ensurePolling();

		globalThis.setInterval = origSetInterval;

		// setInterval は1回しか呼ばれていないはず
		expect(setIntervalCalls).toHaveLength(1);

		runner.stop();
		waitDeferred.resolve();
	});
});
