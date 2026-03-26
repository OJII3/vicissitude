/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AgentRunner, type RunnerDeps } from "@vicissitude/agent/runner";
import type {
	ContextBuilderPort,
	EventBuffer,
	Logger,
	OpencodeSessionEvent,
	OpencodeSessionPort,
	SessionSummaryWriter,
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

function createProfile(): AgentProfile {
	return {
		name: "conversation",
		mcpServers: {},
		builtinTools: {},
		pollingPrompt: "loop forever",
		restartPolicy: "immediate",
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

function createSessionStore(existingSessionId?: string) {
	let sessionId: string | undefined = existingSessionId;
	let createdAt: number | undefined = existingSessionId ? Date.now() - 7_200_000 : undefined;
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

/**
 * ポーリングループ系テスト用: 1回目は firstDone、2回目以降は secondDone を返す sessionPort を作成する。
 * ローテーション後にループが再起動しても secondDone で停止できる。
 */
function createSessionPortWithTwoSessions(
	firstDone: Promise<OpencodeSessionEvent>,
	secondDone: Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & { summarizeSession: ReturnType<typeof mock> } {
	let callCount = 0;
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => {
			callCount += 1;
			return callCount === 1 ? firstDone : secondDone;
		}),
		waitForSessionIdle: mock(() => (callCount === 1 ? firstDone : secondDone)),
		summarizeSession: mock(() => Promise.resolve("これは会話の要約です。")),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & { summarizeSession: ReturnType<typeof mock> };
}

function createEventBuffer(waitImpl: (signal: AbortSignal) => Promise<void>): EventBuffer {
	return {
		append: mock(() => {}),
		waitForEvents: mock(waitImpl),
	};
}

function createSummaryWriter(): SessionSummaryWriter & { write: ReturnType<typeof mock> } {
	return {
		write: mock(() => Promise.resolve()),
	};
}

/** requestSessionRotation テスト用: ポーリングループを使わず直接テストできるシンプルな sessionPort */
function createSimpleSessionPort(): OpencodeSessionPort & {
	summarizeSession: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		summarizeSession: mock(() => Promise.resolve("要約テキスト")),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & { summarizeSession: ReturnType<typeof mock> };
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
	describe("rotateSessionIfExpired での要約生成", () => {
		test("セッションローテーション時に summarizeSession → summaryWriter.write の順で呼ばれる", async () => {
			const callOrder: string[] = [];

			const firstEvent = deferred<void>();
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const eventBuffer = createEventBuffer(() => firstEvent.promise);
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.summarizeSession = mock(() => {
				callOrder.push("summarizeSession");
				return Promise.resolve("要約テキスト");
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
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.ensurePolling();
			firstEvent.resolve();
			await Bun.sleep(0);

			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(1);
			expect(callOrder).toEqual(["summarizeSession", "write"]);
			expect(summaryWriter.write).toHaveBeenCalledWith("123456789", "要約テキスト");

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("summaryWriter.write は sessionPort.deleteSession より前に呼ばれる", async () => {
			const callOrder: string[] = [];

			const firstEvent = deferred<void>();
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const eventBuffer = createEventBuffer(() => firstEvent.promise);
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.summarizeSession = mock(() => {
				callOrder.push("summarizeSession");
				return Promise.resolve("要約");
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
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.ensurePolling();
			firstEvent.resolve();
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			const summarizeIdx = callOrder.indexOf("summarizeSession");
			const writeIdx = callOrder.indexOf("write");
			const deleteIdx = callOrder.indexOf("deleteSession");
			expect(summarizeIdx).toBeLessThan(writeIdx);
			expect(writeIdx).toBeLessThan(deleteIdx);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("セッション期限未到達時はローテーションせず summarizeSession も呼ばれない", async () => {
			const firstEvent = deferred<void>();
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const eventBuffer = createEventBuffer(() => firstEvent.promise);
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.summarizeSession = mock(() => Promise.resolve("要約"));

			const summaryWriter = createSummaryWriter();

			const sessionStore = createSessionStore("existing-session-id");
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 999_999_999,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.ensurePolling();
			firstEvent.resolve();
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});
	});

	describe("要約生成失敗時のフォールバック", () => {
		test("summarizeSession がエラーをスローしても sessionStore.delete は呼ばれる", async () => {
			const firstEvent = deferred<void>();
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const eventBuffer = createEventBuffer(() => firstEvent.promise);
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.summarizeSession = mock(() => Promise.reject(new Error("AI error")));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore("existing-session-id");
			const logger = createLogger();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.ensurePolling();
			firstEvent.resolve();
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
			const firstEvent = deferred<void>();
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const eventBuffer = createEventBuffer(() => firstEvent.promise);
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.summarizeSession = mock(() => Promise.resolve("要約"));

			const summaryWriter = createSummaryWriter();
			summaryWriter.write = mock(() => Promise.reject(new Error("write error")));

			const sessionStore = createSessionStore("existing-session-id");
			const logger = createLogger();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.ensurePolling();
			firstEvent.resolve();
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
		test("contextGuildId が未設定の場合は summarizeSession / summaryWriter.write は呼ばれない", async () => {
			const firstEvent = deferred<void>();
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const eventBuffer = createEventBuffer(() => firstEvent.promise);
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.summarizeSession = mock(() => Promise.resolve("要約"));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore("existing-session-id");

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 0,
				summaryWriter,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.ensurePolling();
			firstEvent.resolve();
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});

		test("summaryWriter が未設定の場合は summarizeSession は呼ばれない", async () => {
			const firstEvent = deferred<void>();
			const firstSessionDone = deferred<OpencodeSessionEvent>();
			const secondSessionDone = deferred<OpencodeSessionEvent>();
			const eventBuffer = createEventBuffer(() => firstEvent.promise);
			const sessionPort = createSessionPortWithTwoSessions(
				firstSessionDone.promise,
				secondSessionDone.promise,
			);
			sessionPort.summarizeSession = mock(() => Promise.resolve("要約"));

			const sessionStore = createSessionStore("existing-session-id");

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 0,
				contextGuildId: "123456789",
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.ensurePolling();
			firstEvent.resolve();
			await Bun.sleep(0);
			firstSessionDone.resolve({ type: "idle" });
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);
			await Bun.sleep(0);

			expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(0);
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);

			runner.stop();
			secondSessionDone.resolve({ type: "cancelled" });
		});
	});

	describe("requestSessionRotation での要約生成", () => {
		test("requestSessionRotation 時も contextGuildId があれば summarizeSession → write が呼ばれる", async () => {
			const eventBuffer = createEventBuffer(() => Promise.resolve());
			const sessionPort = createSimpleSessionPort();
			sessionPort.summarizeSession = mock(() => Promise.resolve("強制ローテーション時の要約"));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "987654321",
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

			await runner.requestSessionRotation();

			expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledTimes(1);
			expect(summaryWriter.write).toHaveBeenCalledWith("987654321", "強制ローテーション時の要約");
		});

		test("requestSessionRotation で contextGuildId が未設定の場合は summarizeSession は呼ばれない", async () => {
			const eventBuffer = createEventBuffer(() => Promise.resolve());
			const sessionPort = createSimpleSessionPort();

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-abc");

			await runner.requestSessionRotation();

			expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(0);
			expect(summaryWriter.write).toHaveBeenCalledTimes(0);
			expect(sessionStore.delete).toHaveBeenCalledTimes(1);
		});

		test("requestSessionRotation で summarizeSession がエラーをスローしてもローテーションは完了する", async () => {
			const eventBuffer = createEventBuffer(() => Promise.resolve());
			const sessionPort = createSimpleSessionPort();
			sessionPort.summarizeSession = mock(() => Promise.reject(new Error("summarize failed")));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();
			const logger = createLogger();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger,
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
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

	describe("summarizeSession の呼び出しパラメータ", () => {
		test("summarizeSession は sessionId と profile の providerId・modelId で呼ばれる", async () => {
			const eventBuffer = createEventBuffer(() => Promise.resolve());
			const sessionPort = createSimpleSessionPort();
			sessionPort.summarizeSession = mock(() => Promise.resolve("要約"));

			const summaryWriter = createSummaryWriter();
			const sessionStore = createSessionStore();

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "guild-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				contextGuildId: "123456789",
				summaryWriter,
			});
			activeRunners.add(runner);

			sessionStore.save("conversation", "__polling__:guild-1", "session-xyz");

			await runner.requestSessionRotation();

			expect(sessionPort.summarizeSession).toHaveBeenCalledWith(
				"session-xyz",
				"test-provider",
				"test-model",
			);
		});
	});
});
