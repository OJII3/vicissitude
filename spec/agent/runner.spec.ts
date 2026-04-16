/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentRunner } from "@vicissitude/agent/runner";
import type {
	ContextBuilderPort,
	OpencodeSessionEvent,
	OpencodeSessionPort,
} from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";
import {
	TestAgent,
	createContextBuilder,
	createEventBuffer,
	createProfile,
	createSessionStore,
	deferred,
} from "./runner-test-helpers.ts";

// ─── ヘルパー ─────────────────────────────────────────────────────

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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
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
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(),
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.stop();

		expect(sessionPort.close).toHaveBeenCalledTimes(1);
	});
});

describe("compacted イベント処理", () => {
	test("compacted 後は waitForEvents を挟まず即座に再監視する", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const rewatchDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => firstSessionDone.promise),
			waitForSessionIdle: mock(() => rewatchDone.promise),
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted イベントを発火
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// waitForEvents は最初の1回のみ（compacted 後に追加呼び出しされない）
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);
		// compacted 後は waitForSessionIdle が呼ばれる（promptAsyncAndWatchSession ではない）
		expect(
			(sessionPort.waitForSessionIdle as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(1);

		runner.stop();
		rewatchDone.resolve({ type: "cancelled" });
	});

	test("compacted 後に delay がリセットされる", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		let callCount = 0;
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => {
				callCount += 1;
				return callCount === 1 ? firstSessionDone.promise : thirdSessionDone.promise;
			}),
			waitForSessionIdle: mock(() => secondSessionDone.promise),
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;

		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted イベント
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted 後にエラーを発生させる
		secondSessionDone.resolve({ type: "error", message: "test error" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// delay がリセットされているので INITIAL (2000ms) から開始
		expect(sleepValues).toContain(2000);

		runner.stop();
		thirdSessionDone.resolve({ type: "cancelled" });
	});

	test("compacted 後に rotateSessionIfExpired がスキップされる", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const rewatchDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => firstSessionDone.promise),
			waitForSessionIdle: mock(() => rewatchDone.promise),
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			eventBuffer,
			// sessionMaxAgeMs: 0 なので通常なら即ローテーションされる
			sessionMaxAgeMs: 0,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted イベント
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted 後は rotateSessionIfExpired がスキップされるので deleteSession は呼ばれない
		expect((sessionPort.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);

		runner.stop();
		rewatchDone.resolve({ type: "cancelled" });
	});
});

describe("エラーからの復帰", () => {
	test("連続エラー時にバックオフ delay が増加する", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			// 2回目は即座に解決（エラー後の再試行を許可）
			if (waitCallCount === 2) return Promise.resolve();
			return new Promise(() => {});
		});
		let sessionCallCount = 0;
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => {
				sessionCallCount += 1;
				if (sessionCallCount === 1) return firstSessionDone.promise;
				if (sessionCallCount === 2) return secondSessionDone.promise;
				return thirdSessionDone.promise;
			}),
			waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;

		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1回目のエラー
		firstSessionDone.resolve({ type: "error", message: "error 1" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 2回目のエラー
		secondSessionDone.resolve({ type: "error", message: "error 2" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// バックオフ: 2000 → 4000
		expect(sleepValues).toContain(2000);
		expect(sleepValues).toContain(4000);

		runner.stop();
		thirdSessionDone.resolve({ type: "cancelled" });
	});

	test("正常復帰後に delay がリセットされる", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
		const fourthSessionDone = deferred<OpencodeSessionEvent>();
		let waitCallCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCallCount += 1;
			if (waitCallCount === 1) return firstEvent.promise;
			// 2回目以降は即座に解決（idle 後の再開を許可）
			if (waitCallCount <= 3) return Promise.resolve();
			return new Promise(() => {});
		});
		let sessionCallCount = 0;
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => {
				sessionCallCount += 1;
				if (sessionCallCount === 1) return firstSessionDone.promise;
				if (sessionCallCount === 2) return secondSessionDone.promise;
				if (sessionCallCount === 3) return thirdSessionDone.promise;
				return fourthSessionDone.promise;
			}),
			waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;

		const sleepValues: number[] = [];
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepValues.push(ms);
			return Promise.resolve();
		};
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラー発生 → delay 2000
		firstSessionDone.resolve({ type: "error", message: "error" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 正常復帰（idle）→ delay リセット
		secondSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 再度エラー → delay が 2000 から始まる（4000 ではない）
		thirdSessionDone.resolve({ type: "error", message: "error again" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 最初のエラーで 2000、idle 後の再エラーで 2000（リセットされている）
		const errorSleeps = sleepValues.filter((v) => v === 2000);
		expect(errorSleeps.length).toBeGreaterThanOrEqual(2);
		// 4000 が含まれないことでリセットが確認できる
		expect(sleepValues).not.toContain(4000);

		runner.stop();
		fourthSessionDone.resolve({ type: "cancelled" });
	});
});

describe("中断安全性", () => {
	test("contextBuilder.build 中に stop されてもセッション開始しない", async () => {
		const firstEvent = deferred<void>();
		const buildDeferred = deferred<string>();
		const contextBuilder: ContextBuilderPort = {
			build: mock(() => buildDeferred.promise),
		};
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder,
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(() => firstEvent.promise),
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// build が未完了の状態で stop
		runner.stop();
		buildDeferred.resolve("system prompt");
		await Bun.sleep(0);
		await Bun.sleep(0);

		// stop 後は promptAsyncAndWatchSession が呼ばれない
		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBe(0);
	});
});

describe("既存セッション再利用", () => {
	test("sessionExists が true を返す場合はセッションを再利用する", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionStore = createSessionStore("existing-session-id");
		const sessionPort = {
			createSession: mock(() => Promise.resolve("new-session")),
			sessionExists: mock(() => Promise.resolve(true)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => firstSessionDone.promise),
			waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// createSession が呼ばれない（既存セッションを再利用）
		expect((sessionPort.createSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
		// sessionExists が呼ばれている
		expect(
			(sessionPort.sessionExists as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(1);

		runner.stop();
		firstSessionDone.resolve({ type: "cancelled" });
	});
});

describe("requestSessionRotation() エラー耐性", () => {
	test("deleteSession がエラーを投げても sessionStore.delete は呼ばれクラッシュしない", async () => {
		const sessionStore = createSessionStore();
		const sessionPort = createSimpleSessionPort();
		(sessionPort.deleteSession as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.reject(new Error("delete failed")),
		);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer: createEventBuffer(),
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		sessionStore.save("conversation", "__polling__:agent-1", "session-abc");

		// 例外がスローされないことを確認（reject されず正常完了する）
		await runner.requestSessionRotation();

		// deleteSession のエラーにもかかわらず sessionStore.delete は呼ばれる
		expect(sessionStore.delete).toHaveBeenCalledTimes(1);
	});
});
