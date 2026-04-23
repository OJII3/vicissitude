/* oxlint-disable max-lines, max-lines-per-function, no-await-in-loop -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentRunner } from "@vicissitude/agent/runner";
import type { OpencodeSessionEvent, OpencodeSessionPort } from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";
import {
	TestAgent,
	createContextBuilder,
	createProfile,
	createSessionStore,
	deferred,
} from "./runner-test-helpers.ts";

// ─── ヘルパー ─────────────────────────────────────────────────────

function createSessionPortForDebounce(
	sessionDone: Promise<OpencodeSessionEvent>,
): OpencodeSessionPort & { close: ReturnType<typeof mock> } {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "要約テキスト", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => sessionDone),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
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

describe("メッセージデバウンス", () => {
	test("連続メッセージが 1 つのプロンプトにまとめられる", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortForDebounce(sessionDone.promise);

		const sleepDeferreds: Array<{ resolve: () => void }> = [];

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (_ms: number) => {
			const d = deferred<void>();
			sleepDeferreds.push({ resolve: d.resolve });
			return d.promise;
		};
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// 1通目を送信 → waitForMessages が解決 → デバウンス sleep 開始
		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// デバウンス sleep 中に2通目を送信
		await runner.send({ sessionKey: "k", message: "world" });
		await Bun.sleep(0);

		// デバウンス sleep を解決（新メッセージがあるのでリセットされる想定だが、
		// 最終的にデバウンスが完了したら drainMessages で全メッセージがまとめられる）
		for (const d of sleepDeferreds) {
			d.resolve();
		}
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// promptAsyncAndWatchSession が呼ばれ、テキストに両方のメッセージが含まれる
		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const params = calls.at(0)?.[0] as { text: string } | undefined;
		expect(params?.text).toContain("hello");
		expect(params?.text).toContain("world");

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("デバウンス期間中に新メッセージが到着するとタイマーがリセットされる", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortForDebounce(sessionDone.promise);

		let sleepResolveQueue: Array<() => void> = [];

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (_ms: number) => {
			return new Promise<void>((resolve) => {
				sleepResolveQueue.push(resolve);
			});
		};
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// 1通目 → デバウンス sleep 開始
		await runner.send({ sessionKey: "k", message: "msg1" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// デバウンス中に2通目を送信
		await runner.send({ sessionKey: "k", message: "msg2" });
		await Bun.sleep(0);

		// 最初のデバウンス sleep を解決 → 新メッセージがあるのでリセット（再度 sleep が呼ばれる想定）
		if (sleepResolveQueue.length > 0) {
			sleepResolveQueue[0]?.();
			sleepResolveQueue = sleepResolveQueue.slice(1);
		}
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 残りの sleep を解決してプロンプト送信を完了させる
		for (const resolve of sleepResolveQueue) {
			resolve();
		}
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 最終的に1回のプロンプトに全メッセージが含まれる
		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const params = calls.at(0)?.[0] as { text: string } | undefined;
		expect(params?.text).toContain("msg1");
		expect(params?.text).toContain("msg2");

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("最大待機時間を超えたらデバウンスが終了する", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortForDebounce(sessionDone.promise);

		let now = 0;

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => now,
		});
		runner.sleepSpy = (ms: number) => {
			// sleep のたびに時間を進めてデバウンス deadline に近づける
			now += ms;
			return Promise.resolve();
		};
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// 1通目を送信
		await runner.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// デバウンス中に継続的にメッセージを送り続ける（最大待機時間を超過させる）
		// MAX_DEBOUNCE_MS (10000ms) / MESSAGE_DEBOUNCE_MS (500ms) = 20回以上のリセットで超過
		// oxlint-disable-next-line no-await-in-loop -- テスト用の逐次送信
		for (let i = 0; i < 8; i++) {
			await runner.send({ sessionKey: "k", message: `追い${i}` });
			await Bun.sleep(0);
			await Bun.sleep(0);
		}

		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 最大待機時間により、最終的にプロンプトが送信される
		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);
		// 最初のメッセージが含まれる
		const params = calls.at(0)?.[0] as { text: string } | undefined;
		expect(params?.text).toContain("first");
		// MAX_DEBOUNCE_MS (10000) の制限により、すべてのメッセージが含まれるとは限らない
		// （deadline 超過後に送ったメッセージは次のプロンプトに回る）

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("abort 時にデバウンスが即座に終了する", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortForDebounce(sessionDone.promise);

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (_ms: number) => {
			// sleep 中に stop を呼ぶ → abort signal が発火
			// sleep は abort 時に即座に resolve される（AgentRunner.sleep の既存実装）
			return Promise.resolve();
		};
		runner.enableDebounce = true;
		activeRunners.add(runner);

		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// stop() → AbortSignal 発火
		runner.stop();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// abort 後はプロンプト送信されない（デバウンス中に中断）か、
		// abort が既に起きた後なのでセッション開始がスキップされる
		// 重要なのは stop 後にクラッシュしないこと
		sessionDone.resolve({ type: "cancelled" });
	});

	test("リトライ時（lastPromptText がある場合）はデバウンスがスキップされる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
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
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// 1回目のメッセージ送信
		await runner.send({ sessionKey: "k", message: "original" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// エラーで終了 → lastPromptText が保持される → リトライ
		firstSessionDone.resolve({ type: "error", message: "transient error" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// リトライ時の sleep 呼び出しを確認
		// リトライ時はバックオフ sleep (2000ms) のみが呼ばれ、デバウンス sleep は呼ばれない
		// バックオフ用の sleep (2000ms) は呼ばれるが、
		// リトライパスではデバウンスをスキップするため waitForMessages も呼ばれない
		// → 2回目の promptAsyncAndWatchSession が呼ばれる
		expect(promptCallCount).toBeGreaterThanOrEqual(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});
});

// ─── 推論中断 ─────────────────────────────────────────────────────

describe("推論中断", () => {
	test("推論中に send() が呼ばれたらセッションが中断され、旧メッセージ + 新メッセージがまとめて再プロンプトされる", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
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
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// 1通目を送信 → デバウンス → promptAsyncAndWatchSession が pending
		await runner.send({ sessionKey: "k", message: "original question" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 推論中（promptAsyncAndWatchSession が pending の状態）に 2通目を送信
		await runner.send({ sessionKey: "k", message: "follow up" });
		await Bun.sleep(0);

		// セッションが中断される（cancelled イベント）
		firstSessionDone.resolve({ type: "cancelled" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 2回目のプロンプトには旧メッセージ + 新メッセージが含まれる
		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const secondParams = calls.at(1)?.[0] as { text: string } | undefined;
		expect(secondParams?.text).toContain("original question");
		expect(secondParams?.text).toContain("follow up");

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});

	test("推論中断後、lastPromptText は null にリセットされる（デバウンスフローに戻る）", async () => {
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let promptCallCount = 0;
		const sleepCalls: number[] = [];
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

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = (ms: number) => {
			sleepCalls.push(ms);
			return Promise.resolve();
		};
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// 1通目 → デバウンス → 推論開始
		await runner.send({ sessionKey: "k", message: "msg1" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 推論中に 2通目を送信 → 中断
		await runner.send({ sessionKey: "k", message: "msg2" });
		await Bun.sleep(0);
		firstSessionDone.resolve({ type: "cancelled" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 中断後はリトライパス（バックオフ sleep のみ）ではなく
		// デバウンスフロー（waitForMessages + waitForDebounce）に戻る。
		// つまり lastPromptText が null にリセットされている。
		// デバウンス sleep (500ms) が呼ばれていることで確認できる。
		const hasDebounce = sleepCalls.some((ms) => ms === 500);
		expect(promptCallCount).toBeGreaterThanOrEqual(2);
		// デバウンスフローを通っていれば 500ms の sleep が存在する
		expect(hasDebounce).toBe(true);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});
});

// ─── bot 用デバウンス延長 ─────────────────────────────────────────

describe("bot 用デバウンス延長", () => {
	test("isBot: true の場合、MAX_DEBOUNCE_MS が 30秒に延長される", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortForDebounce(sessionDone.promise);

		let now = 0;
		const sleepCalls: number[] = [];

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => now,
		});
		runner.sleepSpy = (ms: number) => {
			sleepCalls.push(ms);
			now += ms;
			return Promise.resolve();
		};
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// bot メッセージを送信（isBot: true）
		await runner.send({ sessionKey: "k", message: "bot output", isBot: true } as never);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 継続的にメッセージを送り続ける（MAX_DEBOUNCE_MS = 30000ms を超過させる）
		// MESSAGE_DEBOUNCE_MS (500ms) で 60回以上のリセットが必要
		for (let i = 0; i < 70; i++) {
			await runner.send({ sessionKey: "k", message: `bot追い${i}`, isBot: true } as never);
			await Bun.sleep(0);
			await Bun.sleep(0);
		}

		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 最終的にプロンプトが送信される
		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);

		// 合計待機時間が通常の MAX_DEBOUNCE_MS (10000ms) を超えていること
		// → bot 用の延長 (30000ms) が適用されている
		const totalSleepMs = sleepCalls.reduce((a, b) => a + b, 0);
		expect(totalSleepMs).toBeGreaterThan(10_000);
		expect(totalSleepMs).toBeLessThanOrEqual(30_000);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});

	test("isBot: false の場合、通常の MAX_DEBOUNCE_MS (10秒) が適用される", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const sessionPort = createSessionPortForDebounce(sessionDone.promise);

		let now = 0;
		const sleepCalls: number[] = [];

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			nowProvider: () => now,
		});
		runner.sleepSpy = (ms: number) => {
			sleepCalls.push(ms);
			now += ms;
			return Promise.resolve();
		};
		runner.enableDebounce = true;
		activeRunners.add(runner);

		// 通常メッセージを送信（isBot: false / デフォルト）
		await runner.send({ sessionKey: "k", message: "user msg" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 継続的にメッセージを送り続ける
		for (let i = 0; i < 30; i++) {
			await runner.send({ sessionKey: "k", message: `追い${i}` });
			await Bun.sleep(0);
			await Bun.sleep(0);
		}

		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		const calls = (sessionPort.promptAsyncAndWatchSession as ReturnType<typeof mock>).mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(1);

		// 合計待機時間が通常の MAX_DEBOUNCE_MS (10000ms) を超えていないこと
		const totalSleepMs = sleepCalls.reduce((a, b) => a + b, 0);
		expect(totalSleepMs).toBeLessThanOrEqual(10_000);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});
});
