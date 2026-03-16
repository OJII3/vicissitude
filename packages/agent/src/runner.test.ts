/* oxlint-disable max-lines -- テストファイルはケース数に応じて長くなるため許容 */
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

function createSessionPort(waitImpl: () => Promise<OpencodeSessionEvent>): OpencodeSessionPort & {
	promptAsync: ReturnType<typeof mock>;
	promptAsyncAndWatchSession: ReturnType<typeof mock>;
	waitForSessionIdle: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock((_params, _signal) => waitImpl()),
		waitForSessionIdle: mock(waitImpl),
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
		const waitForSessionIdle = mock(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock((_params, _signal) => waitForSessionIdle()),
			waitForSessionIdle,
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} satisfies OpencodeSessionPort;

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
		const errors: Error[] = [new Error("session error 1"), new Error("session error 2")];
		let sessionWatchCount = 0;
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			if (sessionWatchCount <= 2) {
				return Promise.reject(errors[sessionWatchCount - 1]);
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
