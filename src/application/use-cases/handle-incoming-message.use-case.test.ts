import { describe, expect, it, mock } from "bun:test";

import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import { HandleIncomingMessageUseCase } from "./handle-incoming-message.use-case.ts";
import {
	createMockAgent,
	createMockChannel,
	createMockHistory,
	createMockJudge,
	createMockLogger,
	createMockMessage,
} from "./test-helpers.ts";

describe("HandleIncomingMessageUseCase - 正常系", () => {
	it("正常応答時に reply が呼ばれる", async () => {
		const agent = createMockAgent({ text: "Hello!", sessionId: "s1" });
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("Hi");
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(msg.reply).toHaveBeenCalledWith("Hello!");
	});

	it("空メッセージの場合は何もしない", async () => {
		const agent = createMockAgent({ text: "Hello!", sessionId: "s1" });
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("");
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(msg.reply).not.toHaveBeenCalled();
		expect(agent.send).not.toHaveBeenCalled();
	});

	it("content が空でも添付画像ありなら agent.send が呼ばれる", async () => {
		const agent = createMockAgent({ text: "画像を確認しました", sessionId: "s1" });
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("", {
			attachments: [{ url: "https://cdn.discordapp.com/img.png", contentType: "image/png" }],
			isMentioned: true,
		});
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).toHaveBeenCalledTimes(1);
		const call = (agent.send as ReturnType<typeof mock>).mock.calls[0] as [
			Parameters<typeof agent.send>[0],
		];
		expect(call[0].attachments).toEqual([
			{ url: "https://cdn.discordapp.com/img.png", contentType: "image/png" },
		]);
		expect(msg.reply).toHaveBeenCalledWith("画像を確認しました");
	});

	it("platform フィールドがセッションキーに使われる", async () => {
		const agent = createMockAgent({ text: "OK", sessionId: "s1" });
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("Hi", { platform: "slack" });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).toHaveBeenCalledWith({
			sessionKey: "slack:ch-1:user-1",
			message: "[2026-03-01 15:30] Hi",
			guildId: undefined,
		});
	});
});

describe("HandleIncomingMessageUseCase - 分割送信", () => {
	it("長文応答時に reply + channel.send で分割送信される", async () => {
		const longText = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
		const agent = createMockAgent({ text: longText, sessionId: "s1" });
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("Hi");
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(msg.reply).toHaveBeenCalledTimes(1);
		expect(msg.reply).toHaveBeenCalledWith("a".repeat(1500));
		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(channel.send).toHaveBeenCalledWith("b".repeat(1500));
	});
});

describe("HandleIncomingMessageUseCase - 異常系", () => {
	it("エラー時に汎用メッセージが返される", async () => {
		const agent: AiAgent = {
			send: mock(() => Promise.reject(new Error("Internal path /secret/key leaked"))),
			stop: mock(() => {}),
		};
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("Hi");
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(msg.reply).toHaveBeenCalledWith(
			"エラーが発生しました。しばらく経ってからもう一度お試しください。",
		);
		expect(logger.error).toHaveBeenCalled();
	});
});

describe("HandleIncomingMessageUseCase - Bot メンション判定", () => {
	it("isBot=true かつ judge + history 注入 → judge が呼ばれる", async () => {
		const agent = createMockAgent({ text: "応答", sessionId: "s1" });
		const logger = createMockLogger();
		const judge = createMockJudge({ action: { type: "respond" }, reason: "relevant" });
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const msg = createMockMessage("こんにちは", { isBot: true });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(judge.judge).toHaveBeenCalled();
	});

	it("judge が respond を返す → agent.send が呼ばれる", async () => {
		const agent = createMockAgent({ text: "返答します", sessionId: "s1" });
		const logger = createMockLogger();
		const judge = createMockJudge({ action: { type: "respond" }, reason: "relevant" });
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const msg = createMockMessage("ふあ、元気？", { isBot: true });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).toHaveBeenCalledTimes(1);
		expect(msg.reply).toHaveBeenCalledWith("返答します");
	});

	it("judge が ignore を返す → agent.send が呼ばれない", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		const logger = createMockLogger();
		const judge = createMockJudge({ action: { type: "ignore" }, reason: "not relevant" });
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const msg = createMockMessage("別の話題", { isBot: true });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).not.toHaveBeenCalled();
	});

	it("judge が react を返す → msg.react() が呼ばれ、agent.send は呼ばれない", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		const logger = createMockLogger();
		const judge = createMockJudge({ action: { type: "react", emoji: "👍" }, reason: "agree" });
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const msg = createMockMessage("いいね", { isBot: true });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(msg.react).toHaveBeenCalledWith("👍");
		expect(agent.send).not.toHaveBeenCalled();
	});

	it("judge が例外をスロー → デフォルト ignore（agent.send 呼ばれない）", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		const logger = createMockLogger();
		const judge: ResponseJudge = {
			judge: mock(() => Promise.reject(new Error("AI down"))),
		};
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const msg = createMockMessage("テスト", { isBot: true });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});

	it("isBot=false → judge が注入されていても呼ばれない", async () => {
		const agent = createMockAgent({ text: "OK", sessionId: "s1" });
		const logger = createMockLogger();
		const judge = createMockJudge({ action: { type: "respond" }, reason: "relevant" });
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const msg = createMockMessage("普通のメッセージ", { isBot: false });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(judge.judge).not.toHaveBeenCalled();
		expect(agent.send).toHaveBeenCalledTimes(1);
	});

	it("isBot=true だが judge 未設定 → 早期 return（agent.send 呼ばれない）", async () => {
		const agent = createMockAgent({ text: "Hi", sessionId: "s1" });
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("Botメッセージ", { isBot: true });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).not.toHaveBeenCalled();
	});
});

describe("HandleIncomingMessageUseCase - Bot ループ防止", () => {
	it("連続3回 Bot 応答後は応答しない", async () => {
		const agent = createMockAgent({ text: "応答", sessionId: "s1" });
		const logger = createMockLogger();
		const judge = createMockJudge({ action: { type: "respond" }, reason: "relevant" });
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const channel = createMockChannel();

		// 3回連続 Bot メッセージに応答
		const msg0 = createMockMessage("Bot msg 0", { isBot: true, messageId: "msg-0" });
		await useCase.execute(msg0, channel);
		const msg1 = createMockMessage("Bot msg 1", { isBot: true, messageId: "msg-1" });
		await useCase.execute(msg1, channel);
		const msg2 = createMockMessage("Bot msg 2", { isBot: true, messageId: "msg-2" });
		await useCase.execute(msg2, channel);
		expect(agent.send).toHaveBeenCalledTimes(3);

		// 4回目は上限に達して応答しない
		const msg3 = createMockMessage("Bot msg 3", { isBot: true, messageId: "msg-3" });
		await useCase.execute(msg3, channel);
		expect(agent.send).toHaveBeenCalledTimes(3);
	});

	it("人間メッセージ後はカウンターがリセットされる", async () => {
		const agent = createMockAgent({ text: "応答", sessionId: "s1" });
		const logger = createMockLogger();
		const judge = createMockJudge({ action: { type: "respond" }, reason: "relevant" });
		const history = createMockHistory();
		const useCase = new HandleIncomingMessageUseCase(agent, logger, judge, history);

		const channel = createMockChannel();

		// 3回連続 Bot メッセージに応答
		const botMsg0 = createMockMessage("Bot msg 0", { isBot: true, messageId: "msg-0" });
		await useCase.execute(botMsg0, channel);
		const botMsg1 = createMockMessage("Bot msg 1", { isBot: true, messageId: "msg-1" });
		await useCase.execute(botMsg1, channel);
		const botMsg2 = createMockMessage("Bot msg 2", { isBot: true, messageId: "msg-2" });
		await useCase.execute(botMsg2, channel);
		expect(agent.send).toHaveBeenCalledTimes(3);

		// 人間メッセージでリセット
		const humanMsg = createMockMessage("人間の発言", { isBot: false, messageId: "msg-human" });
		await useCase.execute(humanMsg, channel);
		expect(agent.send).toHaveBeenCalledTimes(4);

		// リセット後は再び Bot メッセージに応答できる
		const botMsg = createMockMessage("Bot again", { isBot: true, messageId: "msg-after" });
		await useCase.execute(botMsg, channel);
		expect(agent.send).toHaveBeenCalledTimes(5);
	});
});
