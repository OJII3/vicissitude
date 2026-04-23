/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { OpencodeSessionPort } from "@vicissitude/shared/types";

import {
	createContextBuilder,
	createProfile,
	createSessionStore,
} from "../../../../spec/agent/runner-test-helpers.ts";
import { createMockLogger } from "../../../../spec/test-helpers.ts";
import type { AgentRunner } from "../runner.ts";
import { DiscordAgent, type DiscordAgentDeps } from "./discord-agent.ts";

// ─── テスト用 DiscordAgent サブクラス ─────────────────────────────

class TestDiscordAgent extends DiscordAgent {
	sleepSpy: ((ms: number) => Promise<void>) | null = null;

	/** pendingCompaction フラグへの公開アクセス */
	get isPendingCompaction(): boolean {
		return (this as unknown as { pendingCompaction: boolean }).pendingCompaction;
	}

	/** lastActivityAt への公開アクセス */
	get currentLastActivityAt(): number | null {
		return (this as unknown as { lastActivityAt: number | null }).lastActivityAt;
	}

	/** lastChannelId への公開アクセス */
	get currentLastChannelId(): string | null {
		return (this as unknown as { lastChannelId: string | null }).lastChannelId;
	}

	/** compactionGapMs への公開アクセス */
	get currentCompactionGapMs(): number {
		return (this as unknown as { compactionGapMs: number }).compactionGapMs;
	}

	/** rotationGapMs への公開アクセス */
	get currentRotationGapMs(): number {
		return (this as unknown as { rotationGapMs: number }).rotationGapMs;
	}

	/** getNow への公開アクセス */
	get currentGetNow(): () => number {
		return (this as unknown as { getNow: () => number }).getNow;
	}

	readonly requestSessionRotationMock = mock((): Promise<void> => Promise.resolve());

	// oxlint-disable-next-line no-useless-constructor -- DiscordAgentDeps 型を受け取るために必要
	constructor(deps: DiscordAgentDeps) {
		super(deps);
	}

	override requestSessionRotation(): Promise<void> {
		const result: Promise<void> = this.requestSessionRotationMock();
		return result;
	}

	/** テスト用: polling loop を起動しない（pendingCompaction フラグが消費されるのを防ぐ） */
	override ensurePolling(): void {}

	protected override sleep(ms: number): Promise<void> {
		if (this.sleepSpy) return this.sleepSpy(ms);
		return super.sleep(ms);
	}
}

// ─── ヘルパー ─────────────────────────────────────────────────────

function createSessionPort(): OpencodeSessionPort {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock(() => Promise.resolve({ type: "idle" as const })),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		deleteSession: mock(() => Promise.resolve()),
		summarizeSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	} as unknown as OpencodeSessionPort;
}

function createAgent(
	opts: {
		nowProvider?: () => number;
		conversationBreak?: { compactionGapMs?: number; rotationGapMs?: number };
	} = {},
): TestDiscordAgent {
	const agent = new TestDiscordAgent({
		guildId: "guild-1",
		profile: createProfile(),
		sessionStore: createSessionStore() as never,
		contextBuilder: createContextBuilder(),
		logger: createMockLogger(),
		sessionPort: createSessionPort(),
		sessionMaxAgeMs: 86_400_000,
		nowProvider: opts.nowProvider,
		conversationBreak: opts.conversationBreak,
	});
	agent.sleepSpy = () => Promise.resolve();
	return agent;
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

// ─── lastActivityAt の更新 ───────────────────────────────────────

describe("lastActivityAt の更新", () => {
	test("send() 後に lastActivityAt が nowProvider の返す値に更新される", async () => {
		const agent = createAgent({ nowProvider: () => 42_000 });
		activeRunners.add(agent);

		expect(agent.currentLastActivityAt).toBeNull();

		await agent.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);

		expect(agent.currentLastActivityAt).toBe(42_000);
	});

	test("2回目の send() で lastActivityAt が最新の時刻に更新される", async () => {
		let now = 1_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);
		expect(agent.currentLastActivityAt).toBe(1_000);

		now = 5_000;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);
		expect(agent.currentLastActivityAt).toBe(5_000);
	});
});

// ─── lastChannelId の更新 ────────────────────────────────────────

describe("lastChannelId の更新", () => {
	test("channelId 付き send() 後に lastChannelId が更新される", async () => {
		const agent = createAgent({ nowProvider: () => 1_000 });
		activeRunners.add(agent);

		expect(agent.currentLastChannelId).toBeNull();

		await agent.send({ sessionKey: "k", message: "hello", channelId: "ch-x" });
		await Bun.sleep(0);

		expect(agent.currentLastChannelId).toBe("ch-x");
	});

	test("channelId なしのメッセージでは lastChannelId は更新されない", async () => {
		let now = 1_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first", channelId: "ch-a" });
		await Bun.sleep(0);
		expect(agent.currentLastChannelId).toBe("ch-a");

		now = 2_000;
		// channelId なし
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		// 前の値が保持される
		expect(agent.currentLastChannelId).toBe("ch-a");
	});

	test("channelId が undefined の場合も lastChannelId は更新されない", async () => {
		let now = 1_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first", channelId: "ch-a" });
		await Bun.sleep(0);

		now = 2_000;
		await agent.send({ sessionKey: "k", message: "second", channelId: undefined });
		await Bun.sleep(0);

		expect(agent.currentLastChannelId).toBe("ch-a");
	});
});

// ─── デフォルト設定値 ────────────────────────────────────────────

describe("ConversationBreakConfig デフォルト値", () => {
	test("conversationBreak 省略時の compactionGapMs は 1_800_000 (30分)", () => {
		const agent = createAgent();
		activeRunners.add(agent);

		expect(agent.currentCompactionGapMs).toBe(1_800_000);
	});

	test("conversationBreak 省略時の rotationGapMs は 21_600_000 (6時間)", () => {
		const agent = createAgent();
		activeRunners.add(agent);

		expect(agent.currentRotationGapMs).toBe(21_600_000);
	});

	test("conversationBreak が空オブジェクトの場合もデフォルト値が適用される", () => {
		const agent = createAgent({ conversationBreak: {} });
		activeRunners.add(agent);

		expect(agent.currentCompactionGapMs).toBe(1_800_000);
		expect(agent.currentRotationGapMs).toBe(21_600_000);
	});
});

// ─── rotation と compaction の排他 ───────────────────────────────

describe("rotation と compaction の排他", () => {
	test("rotation 条件を満たす場合、pendingCompaction は false のまま", async () => {
		const SIX_HOURS = 21_600_000;
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		now += SIX_HOURS;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.requestSessionRotationMock).toHaveBeenCalledTimes(1);
		expect(agent.isPendingCompaction).toBe(false);
	});

	test("rotation ギャップ直前のメッセージは compaction になる", async () => {
		const JUST_UNDER_SIX_HOURS = 21_600_000 - 1;
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		now += JUST_UNDER_SIX_HOURS;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.requestSessionRotationMock).not.toHaveBeenCalled();
		expect(agent.isPendingCompaction).toBe(true);
	});
});

// ─── getNow の使用 ───────────────────────────────────────────────

describe("getNow の使用", () => {
	test("nowProvider が注入された場合、その関数が使われる", async () => {
		const customNow = mock(() => 99_999);
		const agent = createAgent({ nowProvider: customNow });
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "hello" });
		await Bun.sleep(0);

		// nowProvider が send() 内で呼ばれた
		expect(customNow).toHaveBeenCalled();
		expect(agent.currentLastActivityAt).toBe(99_999);
	});

	test("nowProvider 省略時のデフォルトは Date.now と同じ型の関数", () => {
		const agent = createAgent();
		activeRunners.add(agent);

		const result = agent.currentGetNow();
		expect(typeof result).toBe("number");
		// Date.now と近い値（100ms 以内）
		expect(Math.abs(result - Date.now())).toBeLessThan(100);
	});
});

// ─── super.send() の呼び出し ────────────────────────────────────

describe("super.send() の呼び出し", () => {
	test("ブレイク検出後に親クラスの send() が呼ばれ Promise を返す", async () => {
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回
		const result1 = agent.send({ sessionKey: "k", message: "first" });
		expect(result1).toBeInstanceOf(Promise);
		await result1;
		await Bun.sleep(0);

		// compaction トリガー後も send() が正常に完了する
		now += 1_800_000;
		const result2 = agent.send({ sessionKey: "k", message: "second" });
		expect(result2).toBeInstanceOf(Promise);
		await result2;
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(true);
	});

	test("rotation トリガー後も send() が正常に完了する", async () => {
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		now += 21_600_000;
		// rotation が発生しても send() は完了する
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.requestSessionRotationMock).toHaveBeenCalledTimes(1);
		// lastActivityAt は更新されている
		expect(agent.currentLastActivityAt).toBe(now);
	});
});
