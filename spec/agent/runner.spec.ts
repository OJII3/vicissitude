/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AgentRunner, type RunnerDeps } from "@vicissitude/agent/runner";
import type {
	ContextBuilderPort,
	EventBuffer,
	Logger,
	OpencodeSessionEvent,
	OpencodeSessionPort,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "../../packages/agent/src/profile.ts";

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

function createSimpleSessionPort(): OpencodeSessionPort & {
	deleteSession: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & {
		deleteSession: ReturnType<typeof mock>;
		close: ReturnType<typeof mock>;
	};
}

function createSessionPortWithTwoSessions(
	firstDone: Promise<OpencodeSessionEvent>,
	secondDone: Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & { close: ReturnType<typeof mock> } {
	let callCount = 0;
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => {
			callCount += 1;
			return callCount === 1 ? firstDone : secondDone;
		}),
		waitForSessionIdle: mock(() => (callCount === 1 ? firstDone : secondDone)),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & { close: ReturnType<typeof mock> };
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

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

// ─── テスト ───────────────────────────────────────────────────────

describe("send()", () => {
	test("メッセージを EventBuffer に追加する", async () => {
		const eventBuffer = createEventBuffer();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "hello" });

		expect(eventBuffer.append).toHaveBeenCalledTimes(1);
		const appended = (eventBuffer.append as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
			content: string;
		};
		expect(appended.content).toBe("hello");
	});

	test("ポーリングループが未起動なら自動起動する", async () => {
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);

		// waitForEvents が呼ばれていればポーリングループが起動している
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
	});

	test("ポーリングループが起動済みなら二重起動しない", async () => {
		const eventBuffer = createEventBuffer();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);

		// waitForEvents が1回のみ（重複起動していない）
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
	});

	test("{ text: '', sessionId: 'polling' } を返す", async () => {
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(),
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		const response = await runner.send({ sessionKey: "k", message: "hello" });

		expect(response).toEqual({ text: "", sessionId: "polling" });
	});

	test("attachments が含まれる場合、EventBuffer に attachments 付きで追加する", async () => {
		const eventBuffer = createEventBuffer();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		const attachments = [{ url: "https://example.com/image.png", contentType: "image/png" }];
		await runner.send({ sessionKey: "k", message: "画像付きメッセージ", attachments });

		const appended = (eventBuffer.append as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
			attachments?: typeof attachments;
		};
		expect(appended.attachments).toEqual(attachments);
	});

	test("attachments が空配列の場合は undefined として追加する", async () => {
		const eventBuffer = createEventBuffer();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "添付なし", attachments: [] });

		const appended = (eventBuffer.append as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
			attachments?: unknown;
		};
		expect(appended.attachments).toBeUndefined();
	});
});

describe("ensurePolling()", () => {
	test("ポーリングループが未起動なら起動する", async () => {
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		await Bun.sleep(0);

		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
	});

	test("既に起動済みなら二重起動しない（冪等性）", async () => {
		const eventBuffer = createEventBuffer();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		runner.ensurePolling();
		runner.ensurePolling();
		await Bun.sleep(0);

		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
	});

	test("起動後、EventBuffer の waitForEvents が呼ばれる", async () => {
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		await Bun.sleep(0);

		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
	});
});

describe("ポーリングループの lifecycle", () => {
	test("イベント検知後にセッションを作成してプロンプトを送信する", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithTwoSessions(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(1);

		runner.stop();
		firstSessionDone.resolve({ type: "cancelled" });
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("セッションが idle になったら再起動する（immediate ポリシー）", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithTwoSessions(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const runner = new TestAgent({
			profile: createProfile({ restartPolicy: "immediate" }),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// immediate ポリシーではイベント待ちせずに再起動する
		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("セッションが idle になったら新規イベントを待ってから再起動する（wait_for_events ポリシー）", async () => {
		const firstEvent = deferred<void>();
		const secondEvent = deferred<void>();
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			return waitCallCount === 1 ? firstEvent.promise : secondEvent.promise;
		});
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortWithTwoSessions(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const runner = new TestAgent({
			profile: createProfile({ restartPolicy: "wait_for_events" }),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// wait_for_events ポリシーではイベント待ちが再度呼ばれる
		expect(waitCallCount).toBeGreaterThanOrEqual(2);

		runner.stop();
		secondEvent.resolve();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("セッションエラー後に再試行する", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPortWithTwoSessions(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "error", message: "something went wrong" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラー後は sleep でバックオフしてから waitForEvents を再度呼ぶ
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});
});

describe("requestSessionRotation()", () => {
	test("セッションが存在する場合、deleteSession と sessionStore.delete が呼ばれる", async () => {
		const sessionStore = createSessionStore();
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(),
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		sessionStore.save("conversation", "__polling__:agent-1", "session-abc");

		await runner.requestSessionRotation();

		expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-abc");
		expect(sessionStore.delete).toHaveBeenCalledTimes(1);
	});

	test("セッションが存在しない場合、何もしない", async () => {
		const sessionStore = createSessionStore();
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(),
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// sessionStore に何も保存しない状態でローテーションを要求
		await runner.requestSessionRotation();

		expect(sessionPort.deleteSession).not.toHaveBeenCalled();
		expect(sessionStore.delete).not.toHaveBeenCalled();
	});

	test("minRotationIntervalMs 以内の連続呼び出しは無視される", async () => {
		const sessionStore = createSessionStore();
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(),
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		sessionStore.save("conversation", "__polling__:agent-1", "session-abc");

		await runner.requestSessionRotation();
		// 再度セッションを設定して連続呼び出し
		sessionStore.save("conversation", "__polling__:agent-1", "session-xyz");
		await runner.requestSessionRotation();

		// 1回目のみ実行され、2回目は無視される
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(1);
		expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-abc");
	});
});

describe("stop()", () => {
	test("ポーリングループを停止する", async () => {
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		await Bun.sleep(0);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		runner.stop();
		firstEvent.resolve();
		await Bun.sleep(0);

		// stop 後は waitForEvents が追加で呼ばれない
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
	});

	test("sessionPort.close() が呼ばれる", () => {
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(),
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.stop();

		expect(sessionPort.close).toHaveBeenCalledTimes(1);
	});
});
