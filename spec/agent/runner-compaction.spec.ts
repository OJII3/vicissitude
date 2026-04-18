/**
 * Issue #615: AgentRunner にプロアクティブ compaction トリガーを追加
 *
 * 期待仕様:
 * 1. トークン蓄積量が閾値を超えた場合に summarizeSession が呼ばれる
 * 2. 深夜帯（2:00-5:00 JST）にセッションが一定時間アクティブだった場合に summarizeSession が呼ばれる
 * 3. summarizeSession 呼び出し後、compacted イベントで既存の rewatch ロジックがそのまま動く
 * 4. summarizeSession が失敗しても polling loop はクラッシュしない
 * 5. compaction は同一セッション内で連続発火しない（クールダウンあり）
 */
/* oxlint-disable max-lines, max-lines-per-function, no-await-in-loop -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AgentRunner } from "@vicissitude/agent/runner";
import type { OpencodeSessionEvent, OpencodeSessionPort } from "@vicissitude/shared/types";

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

function createSessionPortWithSummarize(overrides?: {
	promptAsyncAndWatchSession?: () => Promise<OpencodeSessionEvent>;
	waitForSessionIdle?: () => Promise<OpencodeSessionEvent>;
}): OpencodeSessionPort & {
	summarizeSession: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession:
			overrides?.promptAsyncAndWatchSession ??
			mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle:
			overrides?.waitForSessionIdle ?? mock(() => Promise.resolve({ type: "idle" as const })),
		deleteSession: mock(() => Promise.resolve()),
		summarizeSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort & {
		summarizeSession: ReturnType<typeof mock>;
		close: ReturnType<typeof mock>;
	};
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

// ─── トークン閾値による compaction ─────────────────────────────

describe("トークン閾値による proactive compaction", () => {
	test("蓄積トークンが閾値を超えた session.idle イベントで summarizeSession が呼ばれる", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const rewatchDone = deferred<OpencodeSessionEvent>();
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: mock(() => sessionDone.promise),
			waitForSessionIdle: mock(() => rewatchDone.promise),
		});

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			// proactive compaction の閾値を低く設定
			compactionTokenThreshold: 1000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// トークン閾値を超えた idle イベントで compaction が発火する
		sessionDone.resolve({
			type: "idle",
			tokens: { input: 800, output: 400, cacheRead: 100 },
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);
		expect(sessionPort.summarizeSession).toHaveBeenCalledWith("session-1");

		runner.stop();
		rewatchDone.resolve({ type: "cancelled" });
	});

	test("蓄積トークンが閾値未満なら summarizeSession は呼ばれない", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const secondDone = deferred<OpencodeSessionEvent>();
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);

		let callCount = 0;
		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: mock(() => {
				callCount++;
				return callCount === 1 ? sessionDone.promise : secondDone.promise;
			}),
		});

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			compactionTokenThreshold: 100_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 閾値未満のトークン
		sessionDone.resolve({
			type: "idle",
			tokens: { input: 100, output: 50, cacheRead: 10 },
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.summarizeSession).not.toHaveBeenCalled();

		runner.stop();
		secondDone.resolve({ type: "cancelled" });
	});
});

// ─── 深夜帯による compaction ─────────────────────────────────────

describe("深夜帯（2:00-5:00 JST）proactive compaction", () => {
	test("深夜帯に sessionMaxAgeMs の半分以上経過していたら summarizeSession が呼ばれる", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const rewatchDone = deferred<OpencodeSessionEvent>();
		const firstEvent = deferred<void>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: mock(() => sessionDone.promise),
			waitForSessionIdle: mock(() => rewatchDone.promise),
		});

		const sessionMaxAgeMs = 3_600_000;
		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs,
			// 閾値は超えないようにする
			compactionTokenThreshold: 999_999,
			// テスト用に現在時刻を深夜帯に差し替え
			nowProvider: () => {
				// 3:00 JST = 18:00 UTC
				const d = new Date("2026-04-18T18:00:00Z");
				return d.getTime();
			},
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// セッションが idle になった（深夜帯 + 一定時間アクティブ）
		sessionDone.resolve({
			type: "idle",
			tokens: { input: 100, output: 50, cacheRead: 10 },
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 深夜帯なので summarizeSession が呼ばれる
		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);

		runner.stop();
		rewatchDone.resolve({ type: "cancelled" });
	});
});

// ─── エラー耐性 ──────────────────────────────────────────────────

describe("proactive compaction のエラー耐性", () => {
	test("summarizeSession が例外をスローしても polling loop はクラッシュしない", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();
		const secondDone = deferred<OpencodeSessionEvent>();
		const firstEvent = deferred<void>();
		let waitCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCount++;
			if (waitCount === 1) return firstEvent.promise;
			return Promise.resolve();
		});

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: mock(() => {
				return waitCount <= 1 ? sessionDone.promise : secondDone.promise;
			}),
		});

		// summarizeSession が例外をスローする
		(sessionPort.summarizeSession as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.reject(new Error("summarize failed")),
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
			compactionTokenThreshold: 100,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compaction 対象のトークン量で idle
		sessionDone.resolve({
			type: "idle",
			tokens: { input: 200, output: 100, cacheRead: 50 },
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// summarizeSession が呼ばれたが例外がスローされた
		expect(sessionPort.summarizeSession).toHaveBeenCalled();
		// polling loop は継続している（クラッシュしない）

		runner.stop();
		secondDone.resolve({ type: "cancelled" });
	});
});

// ─── クールダウン ────────────────────────────────────────────────

describe("proactive compaction のクールダウン", () => {
	test("直前に compaction を実行した場合、クールダウン中は再発火しない", async () => {
		const firstDone = deferred<OpencodeSessionEvent>();
		const secondDone = deferred<OpencodeSessionEvent>();
		const thirdDone = deferred<OpencodeSessionEvent>();
		const firstEvent = deferred<void>();
		let sessionCallCount = 0;
		const eventBuffer = createEventBuffer(() => firstEvent.promise);

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: mock(() => {
				sessionCallCount++;
				if (sessionCallCount === 1) return firstDone.promise;
				if (sessionCallCount === 2) return secondDone.promise;
				return thirdDone.promise;
			}),
			waitForSessionIdle: mock(() => secondDone.promise),
		});

		const runner = new TestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
			compactionTokenThreshold: 100,
			// クールダウンを非常に長くして2回目は発火しないことを確認
			compactionCooldownMs: 999_999,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.ensurePolling();
		firstEvent.resolve();
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 1回目: 閾値超えで compaction 発火
		firstDone.resolve({
			type: "idle",
			tokens: { input: 200, output: 100, cacheRead: 50 },
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compacted イベントで rewatch → 再度 idle（再度閾値超え）
		secondDone.resolve({
			type: "idle",
			tokens: { input: 200, output: 100, cacheRead: 50 },
		});
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// クールダウン中なので2回目は発火しない
		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);

		runner.stop();
		thirdDone.resolve({ type: "cancelled" });
	});
});
