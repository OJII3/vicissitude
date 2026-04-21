/**
 * セッション要約生成がハング/失敗してもローテーションが完遂することを検証する仕様テスト。
 *
 * ## 背景
 *
 * 実運用で判明した問題: 壊れたセッションに summary prompt (`sessionPort.prompt(...)`)
 * を投げても OpenCode 側が応答を返さず、rotation の後段 (`deleteSession`, `sessionStore.delete`)
 * に到達しなくなる。これは age 超過経路 (`rotateSessionIfExpired`) で発生する。
 *
 * ※ session error (retryable:false) 経路は summary 生成自体をスキップするため対象外。
 *
 * ## 契約
 *
 * - summary 生成 (`sessionPort.prompt`) が **永久に pending のまま** でも、
 *   rotation は `sessionPort.deleteSession` → `sessionStore.delete` まで完遂する。
 * - summary 生成が **throw** しても、rotation は完遂する（既存契約の再確認）。
 * - summary 生成が **正常 resolve** する場合は `summaryWriter.write` が呼ばれる（回帰防止）。
 * - **retryable:false 経路では summary 生成自体がスキップされ**、即座に rotation が完遂する。
 *
 * ## RunnerDeps の前提
 *
 * - 実装側で `summaryTimeoutMs` オプションを新設する前提で、本 spec では短い値
 *   (例: 100ms) を指定して現実時間内にテストが完了するよう構成する。
 */
/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
	OpencodeSessionEvent,
	OpencodeSessionPort,
	PromptResult,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "../../packages/agent/src/profile.ts";
import { createMockLogger } from "../test-helpers.ts";
import {
	TestAgent,
	createContextBuilder,
	createProfile as createBaseProfile,
	createSessionStore as createBaseSessionStore,
	deferred,
} from "./runner-test-helpers.ts";

// ─── ヘルパー ─────────────────────────────────────────────────────

const TEST_SUMMARY_PROMPT = "要約してください";
/** summary prompt がハングしても現実時間内にテストが終わるよう十分短い値 */
const SHORT_SUMMARY_TIMEOUT_MS = 100;

function createProfile(overrides: Partial<AgentProfile> = {}) {
	return createBaseProfile({ summaryPrompt: TEST_SUMMARY_PROMPT, ...overrides });
}

function createSessionStore(existingSessionId?: string) {
	return createBaseSessionStore(existingSessionId, { createdAtOffset: -7_200_000 });
}

function createSummaryWriter(): SessionSummaryWriter & { write: ReturnType<typeof mock> } {
	return {
		write: mock(() => Promise.resolve()),
	};
}

/**
 * 単発 rotation 用（ポーリングループを使わず、`forceSessionRotation()` を直接呼ぶ）。
 */
function createSimpleSessionPort(): OpencodeSessionPort & {
	prompt: ReturnType<typeof mock>;
	deleteSession: ReturnType<typeof mock>;
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
		prompt: ReturnType<typeof mock>;
		deleteSession: ReturnType<typeof mock>;
	};
}

/**
 * エラー経路（retryable:false）のポーリングループ用。
 * `promptAsyncAndWatchSession` は 1 回目 `firstDone`、2 回目以降 `secondDone` を返す。
 */
function createSessionPortForPollingLoop(
	firstDone: Promise<OpencodeSessionEvent>,
	secondDone: Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & {
	prompt: ReturnType<typeof mock>;
	deleteSession: ReturnType<typeof mock>;
} {
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
	} as unknown as OpencodeSessionPort & {
		prompt: ReturnType<typeof mock>;
		deleteSession: ReturnType<typeof mock>;
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

describe("セッション要約生成のハング隔離", () => {
	describe("summary prompt が永久に pending のまま（hang）でも rotation は完遂する", () => {
		test("age 超過経路: summary prompt が hang しても deleteSession / sessionStore.delete は呼ばれる", async () => {
			const sessionPort = createSimpleSessionPort();
			// summary 用 prompt が永久に resolve しない状態
			sessionPort.prompt = mock(() => new Promise<PromptResult>(() => {}));

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
				summaryTimeoutMs: SHORT_SUMMARY_TIMEOUT_MS,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-hang");

			// forceSessionRotation は age 超過経路でも使われる公開 API。
			// summary が hang しても現実時間内に resolve することを期待。
			await runner.forceSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-hang");
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
		});

		test("retryable:false エラー経路: summary prompt はスキップされ deleteSession / sessionStore.delete が即座に呼ばれる", async () => {
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const sessionPort = createSessionPortForPollingLoop(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			// summary 用 prompt を mock — retryable:false 経路では呼ばれないはず
			sessionPort.prompt = mock(() => new Promise<PromptResult>(() => {}));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore("existing-session-id");

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
				summaryTimeoutMs: SHORT_SUMMARY_TIMEOUT_MS,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			await runner.send({ sessionKey: "k", message: "test" });
			await Bun.sleep(0);
			await Bun.sleep(0);

			// retryable:false の session error → 即時ローテーション経路
			firstSessionDone.resolve({
				type: "error",
				message: "Bad Request",
				status: 400,
				retryable: false,
			});

			// summary prompt がスキップされるため、timeout 待ちは不要。
			// 非同期処理の伝播を待つために短い待機のみ。
			await Bun.sleep(50);

			// retryable:false 経路では summary 生成がスキップされる
			expect(sessionPort.prompt).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionPort.deleteSession).toHaveBeenCalled();
			expect(sessionStore.delete).toHaveBeenCalled();

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});
	});

	describe("summary prompt が throw しても rotation は完遂する（既存契約の再確認）", () => {
		test("age 超過経路: prompt が reject しても deleteSession / sessionStore.delete は呼ばれる", async () => {
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() => Promise.reject(new Error("prompt failed")));

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
				summaryTimeoutMs: SHORT_SUMMARY_TIMEOUT_MS,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-throw");

			await runner.forceSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-throw");
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
		});
	});

	describe("summary prompt が正常 resolve する場合は summaryWriter.write が呼ばれる（回帰防止）", () => {
		test("age 超過経路: prompt 正常時は write が呼ばれ、rotation も完遂する", async () => {
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() =>
				Promise.resolve({ text: "これは会話の要約", tokens: undefined }),
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
				contextGuildId: "123456789",
				summaryWriter,
				summaryTimeoutMs: SHORT_SUMMARY_TIMEOUT_MS,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-ok");

			await runner.forceSessionRotation();

			expect(sessionPort.prompt).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledWith("123456789", "これは会話の要約");
			expect(sessionPort.deleteSession).toHaveBeenCalledWith("session-ok");
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
		});
	});

	describe("summary abort/timeout 時の callOrder 契約", () => {
		test("summary prompt が hang (timeout) した場合: callOrder は ['prompt', 'deleteSession'] で write はスキップ", async () => {
			const callOrder: string[] = [];
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() => {
				callOrder.push("prompt");
				return new Promise<PromptResult>(() => {});
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
				summaryTimeoutMs: SHORT_SUMMARY_TIMEOUT_MS,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-hang");

			await runner.forceSessionRotation();

			expect(callOrder).toEqual(["prompt", "deleteSession"]);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
		});

		test("summary prompt が throw (reject) した場合: callOrder は ['prompt', 'deleteSession'] で write はスキップ", async () => {
			const callOrder: string[] = [];
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() => {
				callOrder.push("prompt");
				return Promise.reject(new Error("prompt failed"));
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
				summaryTimeoutMs: SHORT_SUMMARY_TIMEOUT_MS,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-throw");

			await runner.forceSessionRotation();

			expect(callOrder).toEqual(["prompt", "deleteSession"]);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
		});
	});

	describe("summary signal 伝播契約", () => {
		test("sessionPort.prompt には AbortSignal が渡され、summary timeout 経過後は aborted となる", async () => {
			const sessionPort = createSimpleSessionPort();

			let capturedSignal: AbortSignal | undefined;
			sessionPort.prompt = mock((_params: unknown, signal?: AbortSignal) => {
				capturedSignal = signal;
				return new Promise<PromptResult>(() => {});
			});

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
				summaryTimeoutMs: SHORT_SUMMARY_TIMEOUT_MS,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-hang");

			await runner.forceSessionRotation();

			expect(capturedSignal).toBeInstanceOf(AbortSignal);
			expect(capturedSignal?.aborted).toBe(true);
		});
	});

	describe("summary timeout のタイミング契約", () => {
		test("summary prompt が hang しても rotation 全体は summaryTimeoutMs + α 以内に完了する", async () => {
			const sessionPort = createSimpleSessionPort();
			sessionPort.prompt = mock(() => new Promise<PromptResult>(() => {}));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const summaryTimeoutMs = SHORT_SUMMARY_TIMEOUT_MS;
			// タイムアウト判定のマージン: 現実の setTimeout 誤差 + 後続処理時間を吸収
			const marginMs = 500;

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
				summaryTimeoutMs,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-hang");

			const start = Date.now();
			await runner.forceSessionRotation();
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(summaryTimeoutMs + marginMs);
			expect(sessionPort.deleteSession).toHaveBeenCalled();
			expect(sessionStore.delete).toHaveBeenCalled();
		});
	});
});
