/**
 * Issue #790: pendingCompaction フラグ消費経路と triggerCompaction() の仕様テスト
 *
 * 期待仕様:
 * 1. pendingCompaction = true のとき ensureSessionStarted が triggerCompaction を呼び summarizeSession が実行される
 * 2. triggerCompaction 成功後、promptAsyncAndWatchSession は呼ばれず waitForSessionIdle（rewatchSession 経由）が呼ばれる
 * 3. クールダウン期間中は triggerCompaction がスキップされ通常のメッセージ処理に進む
 * 4. セッション未存在時は triggerCompaction がスキップされ通常のメッセージ処理に進む
 * 5. summarizeSession が reject しても polling loop はクラッシュせず通常のメッセージ処理に進む
 */
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

// ─── テスト用サブクラス ──────────────────────────────────────────

class BreakTestAgent extends TestAgent {
	setPendingCompaction(value: boolean): void {
		this.pendingCompaction = value;
	}
}

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

// ─── 正常系: pendingCompaction フラグ消費 ─────────────────────────

describe("pendingCompaction フラグ消費による break-triggered compaction", () => {
	test("pendingCompaction = true のとき ensureSessionStarted が summarizeSession を実行する", async () => {
		const rewatchDone = deferred<OpencodeSessionEvent>();

		const sessionPort = createSessionPortWithSummarize({
			waitForSessionIdle: mock(() => rewatchDone.promise),
		});
		// 既存セッションが存在する状態にする
		(sessionPort.sessionExists as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.resolve(true),
		);

		const runner = new BreakTestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore("session-1") as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		// pendingCompaction を立てた状態でメッセージを送る
		runner.setPendingCompaction(true);
		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);
		expect(sessionPort.summarizeSession).toHaveBeenCalledWith("session-1");

		runner.stop();
		rewatchDone.resolve({ type: "cancelled" });
	});

	test("triggerCompaction 成功後、promptAsyncAndWatchSession は呼ばれず waitForSessionIdle が呼ばれる", async () => {
		const rewatchDone = deferred<OpencodeSessionEvent>();

		const promptAsyncAndWatchSessionMock = mock(() => Promise.resolve({ type: "idle" as const }));
		const waitForSessionIdleMock = mock(() => rewatchDone.promise);

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: promptAsyncAndWatchSessionMock,
			waitForSessionIdle: waitForSessionIdleMock,
		});
		(sessionPort.sessionExists as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.resolve(true),
		);

		const runner = new BreakTestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore("session-1") as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.setPendingCompaction(true);
		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// compaction 成功 → rewatchSession 経由で waitForSessionIdle が呼ばれる
		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);
		expect(waitForSessionIdleMock).toHaveBeenCalled();
		// promptAsyncAndWatchSession は呼ばれない（ensureSessionStarted が早期 return）
		expect(promptAsyncAndWatchSessionMock).not.toHaveBeenCalled();

		runner.stop();
		rewatchDone.resolve({ type: "cancelled" });
	});
});

// ─── クールダウン中のスキップ ─────────────────────────────────────

describe("クールダウン中の triggerCompaction スキップ", () => {
	test("クールダウン期間中は triggerCompaction がスキップされ通常のメッセージ処理に進む", async () => {
		// まず1回 compaction を成功させてクールダウンに入る
		const firstRewatchDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();

		const promptAsyncAndWatchSessionMock = mock(() => secondSessionDone.promise);
		const waitForSessionIdleMock = mock(() => firstRewatchDone.promise);

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: promptAsyncAndWatchSessionMock,
			waitForSessionIdle: waitForSessionIdleMock,
		});
		(sessionPort.sessionExists as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.resolve(true),
		);

		const runner = new BreakTestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore("session-1") as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
			// 非常に長いクールダウンで2回目は発火しないことを確認
			compactionCooldownMs: 999_999,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		// 1回目: compaction 成功
		runner.setPendingCompaction(true);
		await runner.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);

		// rewatch 完了 → polling loop が次のイテレーションへ
		firstRewatchDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// 2回目: pendingCompaction を再度立ててメッセージを送る
		runner.setPendingCompaction(true);
		await runner.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// クールダウン中なので summarizeSession は1回目のみ
		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);
		// 通常のメッセージ処理に進む（promptAsyncAndWatchSession が呼ばれる）
		expect(promptAsyncAndWatchSessionMock).toHaveBeenCalled();

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
	});
});

// ─── セッション未存在時のスキップ ─────────────────────────────────

describe("セッション未存在時の triggerCompaction スキップ", () => {
	test("セッションが存在しないとき triggerCompaction がスキップされ通常のメッセージ処理に進む", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();

		const promptAsyncAndWatchSessionMock = mock(() => sessionDone.promise);

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: promptAsyncAndWatchSessionMock,
		});

		// セッションストアにセッションIDが無い状態
		const runner = new BreakTestAgent({
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

		runner.setPendingCompaction(true);
		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// セッション未存在なので summarizeSession は呼ばれない
		expect(sessionPort.summarizeSession).not.toHaveBeenCalled();
		// 通常のメッセージ処理に fall through する（新セッションが作られ promptAsyncAndWatchSession が呼ばれる）
		expect(promptAsyncAndWatchSessionMock).toHaveBeenCalled();

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});
});

// ─── 失敗時の継続 ────────────────────────────────────────────────

describe("triggerCompaction 失敗時の継続", () => {
	test("summarizeSession が reject しても polling loop はクラッシュせず通常のメッセージ処理に進む", async () => {
		const sessionDone = deferred<OpencodeSessionEvent>();

		const promptAsyncAndWatchSessionMock = mock(() => sessionDone.promise);

		const sessionPort = createSessionPortWithSummarize({
			promptAsyncAndWatchSession: promptAsyncAndWatchSessionMock,
		});
		(sessionPort.sessionExists as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.resolve(true),
		);

		// summarizeSession が reject する
		(sessionPort.summarizeSession as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.reject(new Error("summarize failed")),
		);

		const runner = new BreakTestAgent({
			profile: createProfile(),
			agentId: "agent-1",
			sessionStore: createSessionStore("session-1") as never,
			contextBuilder: createContextBuilder(),
			logger: createMockLogger(),
			sessionPort: sessionPort as unknown as OpencodeSessionPort,
			sessionMaxAgeMs: 3_600_000,
		});
		runner.sleepSpy = () => Promise.resolve();
		activeRunners.add(runner);

		runner.setPendingCompaction(true);
		await runner.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);
		await Bun.sleep(0);

		// summarizeSession は呼ばれたが失敗した
		expect(sessionPort.summarizeSession).toHaveBeenCalledTimes(1);
		// 失敗後、通常のメッセージ処理に fall through する
		expect(promptAsyncAndWatchSessionMock).toHaveBeenCalled();

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
	});
});
