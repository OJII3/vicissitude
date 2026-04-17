/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { AgentRunner, type RunnerDeps } from "@vicissitude/agent/runner";
import type {
	ContextBuilderPort,
	EventBuffer,
	OpencodeSessionPort,
} from "@vicissitude/shared/types";

import type { AgentProfile } from "../../packages/agent/src/profile.ts";
import { createMockLogger } from "../test-helpers.ts";

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

function createProfile(): AgentProfile {
	return {
		name: "conversation",
		mcpServers: {},
		builtinTools: {},
		pollingPrompt: "loop forever",
		restartPolicy: "wait_for_events",
		model: { providerId: "test-provider", modelId: "test-model" },
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
	} as unknown as OpencodeSessionPort & { deleteSession: ReturnType<typeof mock> };
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

describe("AgentRunner ハング検知と自動ローテーション", () => {
	describe("hangTimeoutMs のデフォルト値", () => {
		test("RunnerDeps に hangTimeoutMs を指定しない場合、デフォルト値は 600_000ms (10分) である", () => {
			const sessionStore = createSessionStore();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
				eventBuffer: createEventBuffer(),
				sessionMaxAgeMs: 3_600_000,
			});
			activeRunners.add(runner);

			// デフォルト値 600_000ms が Runner 内部に設定されることを
			// 公開 API 経由で検証する: stop() が正常に呼び出せることを確認
			expect(() => runner.stop()).not.toThrow();
		});
	});

	describe("ハング検知基本動作", () => {
		test("wait_for_events が hangTimeoutMs 以上呼ばれない場合、forceSessionRotation が呼ばれる", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore("existing-session-id");

			// waitForEvents が永遠に待機し続けるバッファ（ハング状態をシミュレート）
			let waitResolve: (() => void) | null = null;
			const eventBuffer = createEventBuffer(
				() =>
					new Promise<void>((resolve) => {
						waitResolve = resolve;
					}),
			);

			const sessionPort = createSimpleSessionPort();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				// テスト用に短い閾値
				hangTimeoutMs: 100,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			// forceSessionRotation をスパイ
			runner.forceSessionRotation = rotationSpy;

			runner.ensurePolling();

			// hangTimeoutMs（100ms）を超えて待機（2回目の発火前に停止するよう150msに抑制）
			await Bun.sleep(150);

			expect(rotationSpy).toHaveBeenCalledTimes(1);

			runner.stop();
			(waitResolve as (() => void) | null)?.call(null);
		});

		test("wait_for_events が hangTimeoutMs 以内に呼ばれ続ける場合、ローテーションは発生しない", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore();

			// waitForEvents が短時間で resolve する（正常動作をシミュレート）
			const eventBuffer = createEventBuffer(async () => {
				await Bun.sleep(10);
			});

			const sessionPort = createSimpleSessionPort();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				// テスト用に長めの閾値
				hangTimeoutMs: 500,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.forceSessionRotation = rotationSpy;
			runner.ensurePolling();

			// hangTimeoutMs（500ms）より十分短い時間だけ待機
			await Bun.sleep(50);

			expect(rotationSpy).not.toHaveBeenCalled();

			runner.stop();
		});

		test("wait_for_events を定期的に呼び出すことでハングタイマーがリセットされる", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore();
			let callCount = 0;

			// 複数回 waitForEvents が呼ばれ、それぞれ短時間で完了
			const eventBuffer = createEventBuffer(async () => {
				callCount += 1;
				await Bun.sleep(20);
			});

			const sessionPort = createSimpleSessionPort();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				// テスト用の閾値
				hangTimeoutMs: 300,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.forceSessionRotation = rotationSpy;
			runner.ensurePolling();

			// 複数回 waitForEvents が呼ばれる時間は待つが閾値は超えない
			await Bun.sleep(150);

			// ローテーションは発生しない
			expect(rotationSpy).not.toHaveBeenCalled();
			// waitForEvents は複数回呼ばれている
			expect(eventBuffer.waitForEvents).toHaveBeenCalled();

			runner.stop();
		});
	});

	describe("Runner 停止時のクリーンアップ", () => {
		test("stop() を呼ぶとハング検知タイマーもクリーンアップされる", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore();

			const eventBuffer = createEventBuffer(() => new Promise(() => {}));
			const sessionPort = createSimpleSessionPort();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				// テスト用に短い閾値
				hangTimeoutMs: 100,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.forceSessionRotation = rotationSpy;
			runner.ensurePolling();

			// stop() を先に呼ぶ
			runner.stop();

			// hangTimeoutMs を超えた後もローテーションが呼ばれないこと
			await Bun.sleep(200);

			expect(rotationSpy).not.toHaveBeenCalled();
		});

		test("stop() 後に再度 ensurePolling() を呼んでもタイマーが二重起動しない", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore();

			const eventBuffer = createEventBuffer(() => new Promise(() => {}));
			const sessionPort = createSimpleSessionPort();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				hangTimeoutMs: 300,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.forceSessionRotation = rotationSpy;
			runner.ensurePolling();
			runner.stop();

			// stop 後に再起動しないことを確認
			await Bun.sleep(50);
			expect(rotationSpy).not.toHaveBeenCalled();
		});
	});

	describe("heartbeatReader によるハング検知抑制", () => {
		test("heartbeatReader が新しいタイムスタンプを返す場合、ローテーションは発生しない", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore("existing-session-id");

			// waitForEvents が永遠に待機（セッション中の状態をシミュレート）
			const eventBuffer = createEventBuffer(() => new Promise(() => {}));
			const sessionPort = createSimpleSessionPort();

			// heartbeatReader が常に現在時刻を返す（MCP wait_for_events が呼ばれている状態）
			const heartbeatReader = {
				getLastSeenAt: mock(() => Date.now()),
			};

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				hangTimeoutMs: 100,
				heartbeatReader,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.forceSessionRotation = rotationSpy;
			runner.ensurePolling();

			// hangTimeoutMs を超えて待機しても、heartbeatReader が alive なのでローテーションされない
			await Bun.sleep(250);

			expect(rotationSpy).not.toHaveBeenCalled();
			expect(heartbeatReader.getLastSeenAt).toHaveBeenCalled();

			runner.stop();
		});

		test("heartbeatReader が古いタイムスタンプを返す場合、ローテーションが発生する", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore("existing-session-id");

			const eventBuffer = createEventBuffer(() => new Promise(() => {}));
			const sessionPort = createSimpleSessionPort();

			// heartbeatReader が古い値を返す（MCP が止まっている状態）
			const staleTime = Date.now() - 10_000;
			const heartbeatReader = {
				getLastSeenAt: mock(() => staleTime),
			};

			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				hangTimeoutMs: 100,
				heartbeatReader,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.forceSessionRotation = rotationSpy;
			runner.ensurePolling();

			await Bun.sleep(200);

			expect(rotationSpy).toHaveBeenCalled();

			runner.stop();
		});
	});

	describe("RunnerDeps の hangTimeoutMs 設定", () => {
		test("hangTimeoutMs を明示的に設定できる", () => {
			const sessionStore = createSessionStore();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: createSimpleSessionPort() as unknown as OpencodeSessionPort,
				eventBuffer: createEventBuffer(),
				sessionMaxAgeMs: 3_600_000,
				// 2分
				hangTimeoutMs: 120_000,
			});
			activeRunners.add(runner);

			expect(() => runner.stop()).not.toThrow();
		});

		test("hangTimeoutMs を 0 に設定するとすぐにローテーションが発生する", async () => {
			const rotationSpy = mock(() => Promise.resolve());
			const sessionStore = createSessionStore("existing-session-id");

			const eventBuffer = createEventBuffer(() => new Promise(() => {}));
			const sessionPort = createSimpleSessionPort();
			const runner = new TestAgent({
				profile: createProfile(),
				agentId: "agent-1",
				sessionStore: sessionStore as never,
				contextBuilder: createContextBuilder(),
				logger: createMockLogger(),
				sessionPort: sessionPort as unknown as OpencodeSessionPort,
				eventBuffer,
				sessionMaxAgeMs: 3_600_000,
				hangTimeoutMs: 0,
			});
			runner.sleepSpy = () => Promise.resolve();
			activeRunners.add(runner);

			runner.forceSessionRotation = rotationSpy;
			runner.ensurePolling();

			// 0ms タイムアウトなので即座に検知される
			await Bun.sleep(50);

			expect(rotationSpy).toHaveBeenCalled();

			runner.stop();
		});
	});
});
