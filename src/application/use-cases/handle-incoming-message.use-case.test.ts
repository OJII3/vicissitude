import { describe, expect, it, mock } from "bun:test";

import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import { HandleIncomingMessageUseCase } from "./handle-incoming-message.use-case.ts";
import {
	createMockAgent,
	createMockChannel,
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

	it("platform フィールドがセッションキーに使われる", async () => {
		const agent = createMockAgent({ text: "OK", sessionId: "s1" });
		const logger = createMockLogger();
		const useCase = new HandleIncomingMessageUseCase(agent, logger);

		const msg = createMockMessage("Hi", { platform: "slack" });
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).toHaveBeenCalledWith("slack:ch-1:user-1", "[2026-03-01 15:30] Hi");
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
