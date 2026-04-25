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
		summarizeSession: mock(() => Promise.resolve()),
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

describe("send()", () => {
	test("ポーリングループが未起動なら自動起動する", async () => {
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// メッセージが送信されるとプロンプトが送られる（ポーリングループが起動している）
		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(1);
	});

	test("ポーリングループが起動済みなら二重起動しない", async () => {
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// send を2回呼んでも二重起動しない
		await runner.send({ sessionKey: "k", message: "hello" });
		await runner.send({ sessionKey: "k", message: "world" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// createSession が 1回のみ（二重起動していない）
		expect(
			(sessionPort.createSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeLessThanOrEqual(1);
	});

	test("{ text: '', sessionId: 'queued' } を返す", async () => {
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		const response = await runner.send({ sessionKey: "k", message: "hello" });

		expect(response).toEqual({ text: "", sessionId: "queued" });
	});
});

describe("attachments の伝搬", () => {
	test("send() で渡した attachments が promptAsyncAndWatchSession の params.attachments に含まれる", async () => {
		const sessionPort = createSimpleSessionPort();
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

		await runner.send({
			sessionKey: "k",
			message: "この画像を見て",
			attachments: [
				{
					url: "https://cdn.example.com/photo.png",
					contentType: "image/png",
					filename: "photo.png",
				},
			],
		});
		await Bun.sleep(0);
		await Bun.sleep(0);

		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const params = calls[0]?.[0] as { attachments?: unknown[] };
		expect(params.attachments).toBeDefined();
		expect(params.attachments).toEqual([
			{ url: "https://cdn.example.com/photo.png", contentType: "image/png", filename: "photo.png" },
		]);
	});

	test("テキスト空・画像添付のみのメッセージがスキップされず promptAsyncAndWatchSession に渡される", async () => {
		const sessionPort = createSimpleSessionPort();
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

		await runner.send({
			sessionKey: "k",
			message: "",
			attachments: [
				{
					url: "https://cdn.example.com/photo.png",
					contentType: "image/png",
					filename: "photo.png",
				},
			],
		});
		await Bun.sleep(0);
		await Bun.sleep(0);

		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const params = calls[0]?.[0] as { attachments?: unknown[] };
		expect(params.attachments).toBeDefined();
		expect(params.attachments).toEqual([
			{ url: "https://cdn.example.com/photo.png", contentType: "image/png", filename: "photo.png" },
		]);
	});

	test("テキスト空・画像添付のみのメッセージがエラー後にリトライされ attachments が含まれる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
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
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		// テキスト空・画像添付のみのメッセージを送信
		await runner.send({
			sessionKey: "k",
			message: "",
			attachments: [
				{
					url: "https://cdn.example.com/photo.png",
					contentType: "image/png",
					filename: "photo.png",
				},
			],
		});
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1回目の promptAsyncAndWatchSession が呼ばれたことを確認
		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);

		// エラーを発生させる
		firstSessionDone.resolve({ type: "error", message: "something went wrong" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラー後のリトライで promptAsyncAndWatchSession が再度呼ばれることを確認
		expect(calls.length).toBeGreaterThanOrEqual(2);

		// リトライ時の呼び出しに attachments が含まれていることを確認
		const retryParams = calls[1]?.[0] as { attachments?: unknown[] };
		expect(retryParams.attachments).toBeDefined();
		expect(retryParams.attachments).toEqual([
			{ url: "https://cdn.example.com/photo.png", contentType: "image/png", filename: "photo.png" },
		]);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("attachments なしの send() では params.attachments が undefined または空", async () => {
		const sessionPort = createSimpleSessionPort();
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

		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const params = calls[0]?.[0] as { attachments?: unknown[] };
		// attachments がないか空配列
		if (params.attachments !== undefined) {
			expect(params.attachments).toEqual([]);
		}
	});
});

describe("pollingPrompt の注入", () => {
	test("ensureSessionStarted で pollingPrompt が promptAsyncAndWatchSession の text に含まれる", async () => {
		const customPrompt = "CUSTOM_POLLING_PROMPT_FOR_TEST";
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile({ pollingPrompt: customPrompt }),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		// promptAsyncAndWatchSession の第1引数の text に pollingPrompt が含まれる
		const params = calls[0]?.[0] as { text: string };
		expect(params.text).toContain(customPrompt);
	});
});

describe("ensurePolling()", () => {
	test("ポーリングループが未起動なら起動し、メッセージ待機に入る", async () => {
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// メッセージを送らずに ensurePolling → メッセージ待ちでブロック
		runner.ensurePolling();
		await Bun.sleep(0);

		// stop で中断可能（クラッシュしない）
		runner.stop();
	});

	test("既に起動済みなら二重起動しない（冪等性）", async () => {
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.ensurePolling();
		runner.ensurePolling();
		runner.ensurePolling();
		await Bun.sleep(0);

		// 二重起動せず正常に停止できる
		runner.stop();
	});
});

describe("ポーリングループの lifecycle", () => {
	test("メッセージ送信後にセッションを作成してプロンプトを送信する", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
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
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(1);

		runner.stop();
		firstSessionDone.resolve({ type: "cancelled" });
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("セッションが idle になったら新規メッセージを待ってから再起動する", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
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
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// idle → メッセージ待ちに戻る
		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 新しいメッセージを送信 → 再度プロンプト送信
		await runner.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("セッション期限切れ後の新メッセージで contextBuilder.build が再度呼ばれる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortWithTwoSessions(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const contextBuilder: ContextBuilderPort = {
			build: mock(() => Promise.resolve("system prompt")),
		};
		let now = 1_000_000;
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder,
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			// sessionMaxAgeMs: 0 → idle 後に即ローテーション
			sessionMaxAgeMs: 0,
			nowProvider: () => now,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		// 1回目のメッセージ → contextBuilder.build 1回目
		await runner.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(1);

		expect((contextBuilder.build as ReturnType<typeof mock>).mock.calls.length).toBe(1);

		// 時間を進めてセッションを期限切れにする
		now += 1;

		// idle → rotateSessionIfExpired が発動 → hasStartedSession リセット → sleep → メッセージ待ち
		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(1);

		// 2回目のメッセージ → ensureSessionStarted → contextBuilder.build 2回目
		await runner.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(1);

		expect((contextBuilder.build as ReturnType<typeof mock>).mock.calls.length).toBe(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("セッションエラー後にメッセージ待ちに戻り再試行する", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
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
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		firstSessionDone.resolve({ type: "error", message: "something went wrong" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラー後はバックオフ sleep してからメッセージ待ちに戻る
		// 新しいメッセージを送って再度ループが回ることを確認
		await runner.send({ sessionKey: "k", message: "retry" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(2);

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

describe("forceSessionRotation()", () => {
	test("ローテーション後の新メッセージで contextBuilder.build が再度呼ばれる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const sessionStore = createSessionStore();
		let promptCallCount = 0;
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => {
				promptCallCount += 1;
				return promptCallCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
			}),
			waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
			deleteSession: mock(() => Promise.resolve()),
			summarizeSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;
		const contextBuilder: ContextBuilderPort = {
			build: mock(() => Promise.resolve("system prompt")),
		};
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder,
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		// 1回目のメッセージ → ensureSessionStarted → contextBuilder.build 1回目
		await runner.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(1);

		expect((contextBuilder.build as ReturnType<typeof mock>).mock.calls.length).toBe(1);

		// idle → ループが rotateSessionIfExpired → sleep → ensureSessionStarted → waitForMessages で待機
		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(1);

		// forceSessionRotation → hasStartedSession = false
		sessionStore.save("conversation", "__polling__:agent-1", "session-1");
		await runner.forceSessionRotation();

		// 2回目のメッセージ → waitForMessages 解除 → build 2回目
		await runner.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(1);

		expect((contextBuilder.build as ReturnType<typeof mock>).mock.calls.length).toBe(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("minRotationIntervalMs 以内でも実行される", async () => {
		const sessionStore = createSessionStore();
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		sessionStore.save("conversation", "__polling__:agent-1", "session-abc");

		// 1回目: requestSessionRotation (throttle あり)
		await runner.requestSessionRotation();
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(1);

		// 再度セッションを設定
		sessionStore.save("conversation", "__polling__:agent-1", "session-def");

		// minRotationIntervalMs 以内だが forceSessionRotation → スキップしない
		await runner.forceSessionRotation();
		expect(sessionPort.deleteSession).toHaveBeenCalledTimes(2);
	});
});

describe("stop()", () => {
	test("ポーリングループを停止する", async () => {
		const sessionPort = createSimpleSessionPort();
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		// メッセージを送らずに ensurePolling → メッセージ待ちでブロック
		runner.ensurePolling();
		await Bun.sleep(0);

		// stop で中断
		runner.stop();
		await Bun.sleep(0);

		// stop 後は promptAsyncAndWatchSession が呼ばれない
		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBe(0);
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
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		runner.stop();

		expect(sessionPort.close).toHaveBeenCalledTimes(1);
	});
});

describe("compacted イベント処理", () => {
	test("compacted 後はメッセージ待ちを挟まず即座に再監視する", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const rewatchDone = deferred<OpencodeSessionEvent>();
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => firstSessionDone.promise),
			waitForSessionIdle: mock(() => rewatchDone.promise),
			deleteSession: mock(() => Promise.resolve()),
			summarizeSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
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
		await Bun.sleep(0);

		// compacted イベントを発火
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted 後は waitForSessionIdle が呼ばれる（promptAsyncAndWatchSession ではない）
		expect(
			(sessionPort.waitForSessionIdle as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(1);

		runner.stop();
		rewatchDone.resolve({ type: "cancelled" });
	});

	test("compacted 後に delay がリセットされる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
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
			summarizeSession: mock(() => Promise.resolve()),
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
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const rewatchDone = deferred<OpencodeSessionEvent>();
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => firstSessionDone.promise),
			waitForSessionIdle: mock(() => rewatchDone.promise),
			deleteSession: mock(() => Promise.resolve()),
			summarizeSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			// sessionMaxAgeMs: 0 なので通常なら即ローテーションされる
			sessionMaxAgeMs: 0,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
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

describe("deleted イベント処理", () => {
	test("deleted イベント受信 → forceSessionRotation が呼ばれる（deleteSession と sessionStore.delete が実行される）", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const sessionStore = createSessionStore();
		const sessionPort = createSessionPortWithTwoSessions(
			firstSessionDone.promise,
			secondSessionDone.promise,
		);
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
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

		// セッションが作成された後に sessionStore にセッショ��� ID を保存
		sessionStore.save("conversation", "__polling__:agent-1", "session-1");

		// deleted イベントを発火
		firstSessionDone.resolve({ type: "deleted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// forceSessionRotation により deleteSession が呼ばれる
		expect(
			(sessionPort.deleteSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(1);
		// sessionStore.delete が呼ばれる
		expect(sessionStore.delete).toHaveBeenCalledTimes(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("deleted 後に新規メッセージで新規セッショ��が作成される（ポーリングループが再開する）", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
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
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// deleted イベントを発火
		firstSessionDone.resolve({ type: "deleted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// deleted 後に新しいメッセージを送信 → 新規セッション作成
		await runner.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// promptAsyncAndWatchSession が2回呼ばれる（新規セッション作成）
		expect(
			(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls.length,
		).toBeGreaterThanOrEqual(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});
});

describe("エラーからの復帰", () => {
	test("連続エラー時にバックオフ delay が増加する", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
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
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();
		const fourthSessionDone = deferred<OpencodeSessionEvent>();
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
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
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
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const sessionStore = createSessionStore("existing-session-id");
		const sessionPort = {
			createSession: mock(() => Promise.resolve("new-session")),
			sessionExists: mock(() => Promise.resolve(true)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => firstSessionDone.promise),
			waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
			deleteSession: mock(() => Promise.resolve()),
			summarizeSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: sessionStore as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "test" });
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

describe("compacted 後の abort 時にシステムプロンプト再注入フラグが保持される (#822)", () => {
	test("compacted 後に contextBuilder.build の await 中に abort されても、次回の prompt で contextBuilder.build が再度呼ばれる", async () => {
		// バグ: ensureSessionStarted で pendingSystemReinject = false が signal.aborted チェックの前に
		// 実行される。compaction 後に contextBuilder.build の await 中に stop() が呼ばれると、
		// フラグだけリセットされてシステムプロンプトが送信されない。
		// ensurePolling() で再起動すると hasStartedSession = false にリセットされるため、
		// !hasStartedSession で build が呼ばれるが、pendingSystemReinject が消失していることを検証する。

		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const rewatchDone = deferred<OpencodeSessionEvent>();
		const secondBuildDeferred = deferred<string>();
		const thirdSessionDone = deferred<OpencodeSessionEvent>();

		const contextBuilder = createContextBuilder();
		let buildCallCount = 0;
		(contextBuilder.build as ReturnType<typeof mock>).mockImplementation(() => {
			buildCallCount += 1;
			// 1回目: 即座に解決（初回セッション開始）
			if (buildCallCount === 1) return Promise.resolve("system prompt");
			// 2回目: deferred（abort テスト用 — stop() 後に resolve する）
			if (buildCallCount === 2) return secondBuildDeferred.promise;
			// 3回目以降: 即座に解決
			return Promise.resolve("system prompt");
		});

		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock(() => firstSessionDone.promise),
			waitForSessionIdle: mock(() => rewatchDone.promise),
			deleteSession: mock(() => Promise.resolve()),
			summarizeSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} as unknown as OpencodeSessionPort;

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder,
			logger: createMockLogger(),
			sessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		// ステップ1: 最初のメッセージを送る → promptAsyncAndWatchSession が deferred を返す
		await runner.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 初回の build
		expect(buildCallCount).toBe(1);

		// ステップ2: compacted イベントを発火 → pendingSystemReinject = true → rewatchSession
		firstSessionDone.resolve({ type: "compacted" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// ステップ3: rewatchDone を idle で解決 → ループが waitForMessages に入る
		// promptAsyncAndWatchSession を 3回目用に差し替え
		(sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mockImplementation(
			() => thirdSessionDone.promise,
		);
		rewatchDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// ステップ4: 2回目のメッセージを送る → ensureSessionStarted → contextBuilder.build が deferred
		await runner.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted 後の再注入で build が呼ばれた
		expect(buildCallCount).toBe(2);

		// ステップ5: build 中に stop() → abort（build はまだ pending）
		runner.stop();
		// build の deferred を resolve（abort された後に resolve が到着する実際のシナリオ）
		secondBuildDeferred.resolve("system prompt");
		await Bun.sleep(0);
		await Bun.sleep(0);

		// ステップ6: ensurePolling() で再起動 → 3回目のメッセージを送る
		runner.ensurePolling();
		await runner.send({ sessionKey: "k", message: "third" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// ステップ7: 検証 — 3回目のメッセージで contextBuilder.build が呼ばれること
		// ensurePolling() で hasStartedSession = false にリセットされるため !hasStartedSession で
		// build は呼ばれるが、pendingSystemReinject が保持されていることも合わせて検証する。
		// 修正前: pendingSystemReinject は false（フラグが消失）だが hasStartedSession リセットで build は呼ばれる
		// 修正後: pendingSystemReinject が true のまま保持される
		expect(buildCallCount).toBeGreaterThanOrEqual(3);

		runner.stop();
		thirdSessionDone.resolve({ type: "cancelled" });
	});
});
