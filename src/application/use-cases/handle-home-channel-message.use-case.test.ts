import { describe, expect, it, mock } from "bun:test";

import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import type { EmojiProvider } from "../../domain/ports/emoji-provider.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import { CooldownTracker } from "../../domain/services/cooldown-tracker.ts";
import { HandleHomeChannelMessageUseCase } from "./handle-home-channel-message.use-case.ts";
import {
	createMockAgent,
	createMockChannel,
	createMockChannelConfig,
	createMockEmojiProvider,
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
	logger?: ReturnType<typeof createMockLogger>;
}) {
	return new HandleHomeChannelMessageUseCase(
		overrides.agent ?? createMockAgent({ text: "Hi", sessionId: "s1" }),
		overrides.judge ?? createMockJudge({ action: { type: "ignore" }, reason: "" }),
		overrides.history ?? createMockHistory(),
		createMockChannelConfig(),
		overrides.cooldown ?? new CooldownTracker(),
		overrides.emojiProvider ?? createMockEmojiProvider(),
		overrides.logger ?? createMockLogger(),
	);
}

describe("HandleHomeChannelMessageUseCase - スキップ条件", () => {
	it("空メッセージは無視する", async () => {
		const judge = createMockJudge({ action: { type: "respond" }, reason: "" });
		const useCase = createUseCase({ judge });

		await useCase.execute(createMockMessage(""), createMockChannel());

		expect(judge.judge).not.toHaveBeenCalled();
	});

	it("クールダウン中はスキップする", async () => {
		const judge = createMockJudge({ action: { type: "respond" }, reason: "" });
		const cooldown = new CooldownTracker();
		cooldown.record("ch-1");
		const useCase = createUseCase({ judge, cooldown });

		await useCase.execute(createMockMessage("hello"), createMockChannel());

		expect(judge.judge).not.toHaveBeenCalled();
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
