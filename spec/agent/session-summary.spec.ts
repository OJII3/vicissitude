/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
	OpencodeSessionEvent,
	OpencodeSessionPort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";
import {
	type AgentRunner,
	TestAgent,
	createContextBuilder,
	createProfile as createBaseProfile,
	createSessionStore as createBaseSessionStore,
	deferred,
} from "./runner-test-helpers.ts";

// ─── ヘルパー ─────────────────────────────────────────────────────

const TEST_SUMMARY_PROMPT = "テスト用要約プロンプト";

function createProfile() {
	return createBaseProfile({ summaryPrompt: TEST_SUMMARY_PROMPT });
}

function createSessionStore(existingSessionId?: string) {
	return createBaseSessionStore(existingSessionId, { createdAtOffset: -7_200_000 });
}

/**
 * ポーリングループ系テスト用: 1回目は firstDone、2回目以降は secondDone を返す sessionPort を作成する。
 * ローテーション後にループが再起動しても secondDone で停止できる。
 */
function createSessionPortWithTwoSessions(
	firstDone: Promise<OpencodeSessionEvent>,
	secondDone: Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & { prompt: ReturnType<typeof mock> } {
	let callCount = 0;
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "これは会話の要約です。", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => {
			callCount += 1;
			return callCount === 1 ? firstDone : secondDone;
		}),
		waitForSessionIdle: mock(() => (callCount === 1 ? firstDone : secondDone)),
		deleteSession: mock(() => Promise.resolve()),
		summarizeSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & { prompt: ReturnType<typeof mock> };
}

function createSummaryWriter(): SessionSummaryWriter & { write: ReturnType<typeof mock> } {
	return {
		write: mock(() => Promise.resolve()),
	};
}

/** requestSessionRotation テスト用: ポーリングループを使わず直接テストできるシンプルな sessionPort */
function createSimpleSessionPort(): OpencodeSessionPort & {
	prompt: ReturnType<typeof mock>;
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
	} as unknown as OpencodeSessionPort & { prompt: ReturnType<typeof mock> };
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

// ─── テスト ───────────────────────────────────────────────────────

describe("AgentRunner セッション要約引き継ぎ", () => {
	/**
	 * 本 describe の callOrder 契約は **summary 成功時のみ** を記述する。
	 *
	 * summary がタイムアウト / アボート / reject した場合は、
	 * `write` はスキップされて callOrder が `["prompt", "deleteSession"]` となる。
	 * その隔離契約は `spec/agent/session-rotation-summary-isolation.spec.ts` を参照。
	 */
	describe("rotateSessionIfExpired での要約生成", () => {
		test("セッションローテーション時に prompt → summaryWriter.write の順で呼ばれる（summary 成功時のみ）", async () => {
			const callOrder: string[] = [];

			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.prompt = mock(() => {
				callOrder.push("prompt");
				return Promise.resolve({ text: "要約テキスト", tokens: undefined });
			});

			const summaryWriter = createSummaryWriter();
			summaryWriter.write = mock(() => {
				callOrder.push("write");
				return Promise.resolve();
			});

			const sessionStore = createSessionStore("existing-session-id");
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);

			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(1);
			expect(callOrder).toEqual(["prompt", "write"]);
			expect(summaryWriter.write).toHaveBeenCalledWith("123456789", "要約テキスト");

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("summaryWriter.write は sessionPort.deleteSession より前に呼ばれる（summary 成功時のみ）", async () => {
			const callOrder: string[] = [];

			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.prompt = mock(() => {
				callOrder.push("prompt");
				return Promise.resolve({ text: "要約", tokens: undefined });
			});
			sessionPort.deleteSession = mock(() => {
				callOrder.push("deleteSession");
				return Promise.resolve();
			});

			const summaryWriter = createSummaryWriter();
			summaryWriter.write = mock(() => {
				callOrder.push("write");
				return Promise.resolve();
			});

			const sessionStore = createSessionStore("existing-session-id");
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			const promptIdx = callOrder.indexOf("prompt");
			const writeIdx = callOrder.indexOf("write");
			const deleteIdx = callOrder.indexOf("deleteSession");
			expect(promptIdx).toBeLessThan(writeIdx);
			expect(writeIdx).toBeLessThan(deleteIdx);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("セッション期限未到達時はローテーションせず prompt(要約) も呼ばれない", async () => {
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);

			const summaryWriter = createSummaryWriter();

			const sessionStore = createSessionStore("existing-session-id");
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 999_999_999,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});
	});

	describe("要約生成失敗時のフォールバック", () => {
		test("prompt(要約) がエラーをスローしても sessionStore.delete は呼ばれる", async () => {
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.prompt = mock(() => Promise.reject(new Error("AI error")));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore("existing-session-id");
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(logger.error).toHaveBeenCalled();

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("summaryWriter.write がエラーをスローしても sessionStore.delete は呼ばれる", async () => {
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);

			const summaryWriter = createSummaryWriter();
			summaryWriter.write = mock(() => Promise.reject(new Error("write error")));

			const sessionStore = createSessionStore("existing-session-id");
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
			expect(logger.error).toHaveBeenCalled();

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});
	});

	describe("contextGuildId 未設定時のスキップ", () => {
		test("contextGuildId が未設定の場合は prompt(要約) / summaryWriter.write は呼ばれない", async () => {
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore("existing-session-id");

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 0,
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("summaryPrompt が未設定の場合は prompt(要約) は呼ばれない", async () => {
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore("existing-session-id");

			const profileWithoutSummaryPrompt = { ...createProfile(), summaryPrompt: undefined };
			const runner = new TestAgent({
				profile: profileWithoutSummaryPrompt,
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("summaryWriter が未設定の場合は prompt(要約) は呼ばれない", async () => {
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);

			const sessionStore = createSessionStore("existing-session-id");

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});
	});

	describe("空文字列の要約はスキップ", () => {
		test("prompt が空文字列を返した場合は summaryWriter.write は呼ばれない", async () => {
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() => Promise.resolve({ text: "", tokens: undefined }));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "123456789",
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

			await runner.requestSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			// ローテーション自体は行われる
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
		});

		test("prompt が空白のみを返した場合も summaryWriter.write は呼ばれない", async () => {
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() => Promise.resolve({ text: "   \n  ", tokens: undefined }));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "123456789",
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

			await runner.requestSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
		});
	});

	describe("requestSessionRotation での要約生成", () => {
		test("requestSessionRotation 時も contextGuildId があれば prompt → write が呼ばれる", async () => {
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() =>
				Promise.resolve({ text: "強制ローテーション時の要約", tokens: undefined }),
			);

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "987654321",
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

			await runner.requestSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledWith("987654321", "強制ローテーション時の要約");
		});

		test("requestSessionRotation で contextGuildId が未設定の場合は prompt(要約) は呼ばれない", async () => {
			const sessionPort = createSimpleSessionPort();

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

			await runner.requestSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
		});

		test("requestSessionRotation で prompt(要約) がエラーをスローしてもローテーションは完了する", async () => {
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() => Promise.reject(new Error("summarize failed")));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();
			const logger = createMockLogger();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "123456789",
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

			await runner.requestSessionRotation();

			expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-abc");
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
		});
	});

	describe("prompt(要約) の呼び出しパラメータ", () => {
		test("prompt は sessionId・summaryPrompt・model・AbortSignal で呼ばれる", async () => {
			const sessionPort = createSimpleSessionPort();

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "123456789",
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-xyz");

			await runner.requestSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledWith(
				{
					sessionId: "session-xyz",
					text: TEST_SUMMARY_PROMPT,
					model: { providerId: "test-provider", modelId: "test-model" },
					tools: {},
				},
				expect.any(AbortSignal),
			);
		});
	});
});
