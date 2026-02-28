import { describe, expect, it, mock } from "bun:test";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";
import { HandleIncomingMessageUseCase } from "./handle-incoming-message.use-case.ts";

function createMockAgent(response: AgentResponse): AiAgent {
	return {
		send: mock(() => Promise.resolve(response)),
		stop: mock(() => {}),
	};
}

function createMockLogger(): Logger {
	return {
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
	};
}

function createMockMessage(content: string): IncomingMessage {
	return {
		platform: "test",
		channelId: "ch-1",
		authorId: "user-1",
		content,
		reply: mock(() => Promise.resolve()),
	};
}

function createMockChannel(): MessageChannel {
	return {
		sendTyping: mock(() => Promise.resolve()),
		send: mock(() => Promise.resolve()),
	};
}

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

		const msg = createMockMessage("Hi");
		msg.platform = "slack";
		const channel = createMockChannel();

		await useCase.execute(msg, channel);

		expect(agent.send).toHaveBeenCalledWith("slack:ch-1:user-1", "Hi");
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
