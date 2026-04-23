/**
 * 会話ブレイク検出の仕様テスト
 *
 * DiscordAgent の send() オーバーライドで以下を検出する:
 * 1. 時間ギャップによる compaction (デフォルト: 30分)
 * 2. 時間ギャップによる session rotation (デフォルト: 6時間)
 * 3. チャンネル変更 + 時間ギャップによる compaction
 * 4. 初回メッセージではブレイク検出を行わない
 */
/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, test } from "bun:test";

import type { AgentRunner } from "@vicissitude/agent/runner";

import { createAgent } from "./discord-agent-test-helpers.ts";

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

// ─── 時間ギャップ ─────────────────────────────────────────────────

describe("時間ギャップによるブレイク検出", () => {
	test("30分以上のギャップ後にメッセージが来たら pendingCompaction が true になる", async () => {
		const THIRTY_MIN = 1_800_000;
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回メッセージ
		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		// 30分後
		now += THIRTY_MIN;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(true);
	});

	test("30分未満のギャップでは pendingCompaction は false のまま", async () => {
		const TWENTY_NINE_MIN = 1_800_000 - 1;
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回メッセージ
		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		// 29分59秒999ms後
		now += TWENTY_NINE_MIN;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(false);
	});

	test("6時間以上のギャップ後にメッセージが来たら requestSessionRotation() が呼ばれる", async () => {
		const SIX_HOURS = 21_600_000;
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回メッセージ
		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		// 6時間後
		now += SIX_HOURS;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.requestSessionRotationMock).toHaveBeenCalledTimes(1);
	});

	test("6時間ギャップでは pendingCompaction は立たない（rotation が優先）", async () => {
		const SIX_HOURS = 21_600_000;
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回メッセージ
		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		// 6時間後
		now += SIX_HOURS;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(false);
	});
});

// ─── チャンネル変更 ───────────────────────────────────────────────

describe("チャンネル変更によるブレイク検出", () => {
	test("チャンネル変更 + 時間ギャップありで pendingCompaction が true になる", async () => {
		let now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回メッセージ（チャンネルA）
		await agent.send({ sessionKey: "k", message: "first", channelId: "ch-a" });
		await Bun.sleep(0);

		// 1ms 後に別チャンネル
		now += 1;
		await agent.send({ sessionKey: "k", message: "second", channelId: "ch-b" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(true);
	});

	test("チャンネル変更 + 時間ギャップなし（同タイミング）では何も起きない", async () => {
		const now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回メッセージ（チャンネルA）
		await agent.send({ sessionKey: "k", message: "first", channelId: "ch-a" });
		await Bun.sleep(0);

		// 同時刻に別チャンネル
		await agent.send({ sessionKey: "k", message: "second", channelId: "ch-b" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(false);
		expect(agent.requestSessionRotationMock).not.toHaveBeenCalled();
	});

	test("同じチャンネルで時間ギャップなしでは何も起きない", async () => {
		const now = 1_000_000;
		const agent = createAgent({ nowProvider: () => now });
		activeRunners.add(agent);

		// 初回メッセージ
		await agent.send({ sessionKey: "k", message: "first", channelId: "ch-a" });
		await Bun.sleep(0);

		// 同時刻・同チャンネル
		await agent.send({ sessionKey: "k", message: "second", channelId: "ch-a" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(false);
		expect(agent.requestSessionRotationMock).not.toHaveBeenCalled();
	});
});

// ─── 初回メッセージ ───────────────────────────────────────────────

describe("初回メッセージ", () => {
	test("最初のメッセージではブレイク検出は行われない", async () => {
		const agent = createAgent({ nowProvider: () => 1_000_000 });
		activeRunners.add(agent);

		// 初回メッセージのみ
		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(false);
		expect(agent.requestSessionRotationMock).not.toHaveBeenCalled();
	});
});

// ─── カスタム設定 ─────────────────────────────────────────────────

describe("ConversationBreakConfig によるカスタマイズ", () => {
	test("compactionGapMs をカスタマイズできる", async () => {
		let now = 1_000_000;
		const agent = createAgent({
			nowProvider: () => now,
			// 1分
			conversationBreak: { compactionGapMs: 60_000 },
		});
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		// 1分後
		now += 60_000;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.isPendingCompaction).toBe(true);
	});

	test("rotationGapMs をカスタマイズできる", async () => {
		let now = 1_000_000;
		const agent = createAgent({
			nowProvider: () => now,
			// 1時間
			conversationBreak: { rotationGapMs: 3_600_000 },
		});
		activeRunners.add(agent);

		await agent.send({ sessionKey: "k", message: "first" });
		await Bun.sleep(0);

		// 1時間後
		now += 3_600_000;
		await agent.send({ sessionKey: "k", message: "second" });
		await Bun.sleep(0);

		expect(agent.requestSessionRotationMock).toHaveBeenCalledTimes(1);
	});
});
