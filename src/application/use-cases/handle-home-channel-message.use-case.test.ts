import { describe, expect, it, mock } from "bun:test";

import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import type { EmojiProvider } from "../../domain/ports/emoji-provider.port.ts";
import type { EmojiUsageTracker } from "../../domain/ports/emoji-usage-tracker.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import { CooldownTracker } from "../../domain/services/cooldown-tracker.ts";
import { MessageBatcher } from "../../domain/services/message-batcher.ts";
import { HandleHomeChannelMessageUseCase } from "./handle-home-channel-message.use-case.ts";
import {
	createMockAgent,
	createMockChannel,
	createMockChannelConfig,
	createMockEmojiProvider,
	createMockEmojiUsageTracker,
	createMockHistory,
	createMockJudge,
	createMockLogger,
	createMockMessage,
} from "./test-helpers.ts";

function createUseCase(overrides: {
	agent?: ReturnType<typeof createMockAgent>;
	judge?: ResponseJudge;
	history?: ConversationHistory;
	cooldown?: CooldownTracker;
	emojiProvider?: EmojiProvider;
	emojiUsageTracker?: EmojiUsageTracker;
	logger?: ReturnType<typeof createMockLogger>;
	batcher?: MessageBatcher;
}) {
	return new HandleHomeChannelMessageUseCase(
		overrides.agent ?? createMockAgent({ text: "Hi", sessionId: "s1" }),
		overrides.judge ?? createMockJudge({ action: { type: "ignore" }, reason: "" }),
		overrides.history ?? createMockHistory(),
		createMockChannelConfig(),
		overrides.cooldown ?? new CooldownTracker(),
		overrides.emojiProvider ?? createMockEmojiProvider(),
		overrides.emojiUsageTracker ?? createMockEmojiUsageTracker(),
		overrides.logger ?? createMockLogger(),
		overrides.batcher ?? new MessageBatcher(),
	);
}

describe("HandleHomeChannelMessageUseCase - スキップ条件", () => {
	it("空メッセージは無視する", async () => {
		const judge = createMockJudge({ action: { type: "respond" }, reason: "" });
		const useCase = createUseCase({ judge });

		await useCase.execute(createMockMessage(""), createMockChannel());

		expect(judge.judge).not.toHaveBeenCalled();
	});

	it("クールダウン中はキューに溜まり judge は呼ばれない", async () => {
		const judge = createMockJudge({ action: { type: "respond" }, reason: "" });
		const cooldown = new CooldownTracker();
		cooldown.record("ch-1");
		const batcher = new MessageBatcher();
		const useCase = createUseCase({ judge, cooldown, batcher });

		await useCase.execute(createMockMessage("hello"), createMockChannel());

		expect(judge.judge).not.toHaveBeenCalled();
		expect(batcher.hasPending("ch-1")).toBe(true);
	});
});

describe("HandleHomeChannelMessageUseCase - 判断結果", () => {
	it("ignore → 何もしないがクールダウンは記録される", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		const judge = createMockJudge({ action: { type: "ignore" }, reason: "not relevant" });
		const cooldown = new CooldownTracker();
		const useCase = createUseCase({ agent, judge, cooldown });

		const msg = createMockMessage("hello");
		const channel = createMockChannel();
		await useCase.execute(msg, channel);

		expect(agent.send).not.toHaveBeenCalled();
		expect(msg.react).not.toHaveBeenCalled();
		expect(channel.send).not.toHaveBeenCalled();
		expect(cooldown.isOnCooldown("ch-1", 60)).toBe(true);
	});
	it("react → リアクションしてクールダウン記録", async () => {
		const judge = createMockJudge({ action: { type: "react", emoji: "👍" }, reason: "agree" });
		const cooldown = new CooldownTracker();
		const useCase = createUseCase({ judge, cooldown });

		const msg = createMockMessage("nice work!");
		await useCase.execute(msg, createMockChannel());

		expect(msg.react).toHaveBeenCalledWith("👍");
		expect(cooldown.isOnCooldown("ch-1", 60)).toBe(true);
	});
	it("react（カスタム絵文字）→ identifier に解決してリアクション", async () => {
		const judge = createMockJudge({
			action: { type: "react", emoji: ":pepe_sad:" },
			reason: "sad",
		});
		const emojiProvider = createMockEmojiProvider([
			{ name: "pepe_sad", identifier: "123456789", animated: false },
			{ name: "pepe_happy", identifier: "987654321", animated: true },
		]);
		const useCase = createUseCase({ judge, emojiProvider });

		const msg = createMockMessage("つらい", { guildId: "guild-1" });
		await useCase.execute(msg, createMockChannel());

		expect(msg.react).toHaveBeenCalledWith("123456789");
	});
	it("react（不明なカスタム絵文字）→ そのまま渡す", async () => {
		const judge = createMockJudge({
			action: { type: "react", emoji: ":unknown_emoji:" },
			reason: "test",
		});
		const emojiProvider = createMockEmojiProvider([
			{ name: "pepe_sad", identifier: "123456789", animated: false },
		]);
		const useCase = createUseCase({ judge, emojiProvider });

		const msg = createMockMessage("test", { guildId: "guild-1" });
		await useCase.execute(msg, createMockChannel());

		expect(msg.react).toHaveBeenCalledWith(":unknown_emoji:");
	});

	it("respond → AI 応答を送信してクールダウン記録", async () => {
		const agent = createMockAgent({ text: "やっほー", sessionId: "s1" });
		const judge = createMockJudge({ action: { type: "respond" }, reason: "talking to me" });
		const cooldown = new CooldownTracker();
		const useCase = createUseCase({ agent, judge, cooldown });

		const msg = createMockMessage("ふあどう思う？");
		const channel = createMockChannel();
		await useCase.execute(msg, channel);

		expect(agent.send).toHaveBeenCalledWith({
			sessionKey: "test:ch-1:_channel",
			message: "[2026-03-01 15:30] TestUser: ふあどう思う？",
			guildId: undefined,
		});
		expect(channel.send).toHaveBeenCalledWith("やっほー");
		expect(cooldown.isOnCooldown("ch-1", 60)).toBe(true);
	});
});

describe("HandleHomeChannelMessageUseCase - バッチ処理", () => {
	it("複数メッセージが結合されて AI に渡される", async () => {
		const agent = createMockAgent({ text: "まとめて返すよ", sessionId: "s1" });
		const judge = createMockJudge({ action: { type: "respond" }, reason: "talk" });
		const batcher = new MessageBatcher();
		const cooldown = new CooldownTracker();
		const useCase = createUseCase({ agent, judge, cooldown, batcher });

		// 最初のメッセージでクールダウンに入る前に batcher に手動でキューイング
		const msg1 = createMockMessage("おはよう", {
			messageId: "msg-1",
			authorName: "UserA",
			timestamp: new Date("2026-03-01T06:30:00Z"),
		});
		const msg2 = createMockMessage("元気？", {
			messageId: "msg-2",
			authorName: "UserB",
			timestamp: new Date("2026-03-01T06:30:05Z"),
		});
		const channel = createMockChannel();

		// 先にメッセージを batcher にキューイングしておく
		batcher.enqueue("ch-1", msg1, channel);

		// 2つ目のメッセージで execute → batcher に msg2 も追加され、バッチ処理される
		await useCase.execute(msg2, channel);

		// agent.send に渡されるプロンプトに両メッセージが含まれる
		expect(agent.send).toHaveBeenCalledWith({
			sessionKey: "test:ch-1:_channel",
			message: "[2026-03-01 15:30] UserA: おはよう\n[2026-03-01 15:30] UserB: 元気？",
			guildId: undefined,
		});
		expect(channel.send).toHaveBeenCalledWith("まとめて返すよ");
	});
});

describe("HandleHomeChannelMessageUseCase - 絵文字フィルタリング", () => {
	const allEmojis = [
		{ name: "pepe_sad", identifier: "111", animated: false },
		{ name: "pepe_happy", identifier: "222", animated: true },
		{ name: "thumbsup", identifier: "333", animated: false },
		{ name: "fire", identifier: "444", animated: false },
	];

	it("使用データあり → トップ N のみ judge に渡る", async () => {
		const judge = createMockJudge({ action: { type: "ignore" }, reason: "" });
		const emojiProvider = createMockEmojiProvider(allEmojis);
		const emojiUsageTracker = createMockEmojiUsageTracker({
			"guild-1": [
				{ emojiName: "fire", count: 100 },
				{ emojiName: "pepe_sad", count: 50 },
			],
		});
		const useCase = createUseCase({ judge, emojiProvider, emojiUsageTracker });

		await useCase.execute(createMockMessage("hello", { guildId: "guild-1" }), createMockChannel());

		expect(judge.judge).toHaveBeenCalledWith("hello", expect.anything(), [
			{ name: "fire", identifier: "444", animated: false },
			{ name: "pepe_sad", identifier: "111", animated: false },
		]);
	});

	it("コールドスタート（使用データなし）→ 全絵文字が渡る", async () => {
		const judge = createMockJudge({ action: { type: "ignore" }, reason: "" });
		const emojiProvider = createMockEmojiProvider(allEmojis);
		const emojiUsageTracker = createMockEmojiUsageTracker({});
		const useCase = createUseCase({ judge, emojiProvider, emojiUsageTracker });

		await useCase.execute(createMockMessage("hello", { guildId: "guild-1" }), createMockChannel());

		expect(judge.judge).toHaveBeenCalledWith("hello", expect.anything(), allEmojis);
	});

	it("フィルタ結果空（全て削除済み）→ 全絵文字フォールバック", async () => {
		const judge = createMockJudge({ action: { type: "ignore" }, reason: "" });
		const emojiProvider = createMockEmojiProvider(allEmojis);
		const emojiUsageTracker = createMockEmojiUsageTracker({
			"guild-1": [{ emojiName: "deleted_emoji", count: 99 }],
		});
		const useCase = createUseCase({ judge, emojiProvider, emojiUsageTracker });

		await useCase.execute(createMockMessage("hello", { guildId: "guild-1" }), createMockChannel());

		expect(judge.judge).toHaveBeenCalledWith("hello", expect.anything(), allEmojis);
	});

	it("react 時は allEmojis（フィルタ前）で resolveEmoji する", async () => {
		const judge = createMockJudge({
			action: { type: "react", emoji: ":thumbsup:" },
			reason: "agree",
		});
		const emojiProvider = createMockEmojiProvider(allEmojis);
		// thumbsup はトップ N に含まれていないが、allEmojis には存在する
		const emojiUsageTracker = createMockEmojiUsageTracker({
			"guild-1": [{ emojiName: "fire", count: 100 }],
		});
		const useCase = createUseCase({ judge, emojiProvider, emojiUsageTracker });

		const msg = createMockMessage("nice!", { guildId: "guild-1" });
		await useCase.execute(msg, createMockChannel());

		expect(msg.react).toHaveBeenCalledWith("333");
	});
});

describe("HandleHomeChannelMessageUseCase - エラー処理", () => {
	it("judge エラー時は安全側(ignore)に倒す", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		const judge: ResponseJudge = {
			judge: mock(() => Promise.reject(new Error("AI error"))),
		};
		const logger = createMockLogger();
		const useCase = createUseCase({ agent, judge, logger });

		const channel = createMockChannel();
		await useCase.execute(createMockMessage("hello"), channel);

		expect(agent.send).not.toHaveBeenCalled();
		expect(channel.send).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});
	it("history エラー時は安全側(ignore)に倒す", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		const history: ConversationHistory = {
			getRecent: mock(() => Promise.reject(new Error("Discord API error"))),
		};
		const logger = createMockLogger();
		const useCase = createUseCase({ agent, history, logger });

		const channel = createMockChannel();
		await useCase.execute(createMockMessage("hello"), channel);

		expect(agent.send).not.toHaveBeenCalled();
		expect(channel.send).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});
	it("respond 時に agent エラーでも typing が停止する", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		agent.send = mock(() => Promise.reject(new Error("AI down")));
		const judge = createMockJudge({ action: { type: "respond" }, reason: "talk" });
		const logger = createMockLogger();
		const useCase = createUseCase({ agent, judge, logger });

		const channel = createMockChannel();
		await useCase.execute(createMockMessage("hello"), channel);

		expect(channel.send).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});
});
