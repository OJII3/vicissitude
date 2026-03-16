import { describe, expect, it } from "bun:test";

import type { Emotion } from "@vicissitude/shared/emotion";
import { NEUTRAL_EMOTION, createEmotion } from "@vicissitude/shared/emotion";
import type {
	AvatarCommand,
	AvatarController,
	ClientMessageHandler,
	ConnectionId,
	EmotionAnalysisInput,
	EmotionAnalysisResult,
	EmotionAnalyzer,
	GatewayPort,
} from "@vicissitude/shared/ports";
import type { AgentResponse } from "@vicissitude/shared/types";
import type { ClientMessage, ServerMessage } from "@vicissitude/shared/ws-protocol";

// ─── EmotionAnalyzer (type contract) ────────────────────────────

describe("EmotionAnalyzer", () => {
	it("defines an analyze method that accepts EmotionAnalysisInput and returns EmotionAnalysisResult", async () => {
		const stubAnalyzer: EmotionAnalyzer = {
			analyze(_input: EmotionAnalysisInput): Promise<EmotionAnalysisResult> {
				return Promise.resolve({
					emotion: createEmotion(0.5, 0.3, 0.1),
					confidence: 0.9,
				});
			},
		};

		const result = await stubAnalyzer.analyze({ text: "やったー！" });
		expect(result.emotion.valence).toBeCloseTo(0.5);
		expect(result.emotion.arousal).toBeCloseTo(0.3);
		expect(result.emotion.dominance).toBeCloseTo(0.1);
		expect(result.confidence).toBeCloseTo(0.9);
	});

	it("accepts optional context in input", async () => {
		const stubAnalyzer: EmotionAnalyzer = {
			analyze(input: EmotionAnalysisInput): Promise<EmotionAnalysisResult> {
				return Promise.resolve({
					emotion: input.context ? createEmotion(0.8, 0.5, 0.2) : NEUTRAL_EMOTION,
					confidence: input.context ? 0.95 : 0.5,
				});
			},
		};

		const withContext = await stubAnalyzer.analyze({
			text: "ありがとう",
			context: "ユーザーがプレゼントをくれた",
		});
		expect(withContext.confidence).toBeCloseTo(0.95);

		const withoutContext = await stubAnalyzer.analyze({ text: "ありがとう" });
		expect(withoutContext.confidence).toBeCloseTo(0.5);
	});
});

// ─── AvatarController (type contract) ───────────────────────────

describe("AvatarController", () => {
	it("defines applyEmotion that accepts Emotion and returns AvatarCommand", async () => {
		const stubController: AvatarController = {
			applyEmotion(_emotion: Emotion): Promise<AvatarCommand> {
				return Promise.resolve({
					expressionWeight: { expression: "happy", weight: 0.8 },
					animation: "happy",
					animationIntensity: 0.7,
				});
			},
			playAnimation(): Promise<void> {
				return Promise.resolve();
			},
		};

		const cmd = await stubController.applyEmotion(createEmotion(0.8, 0.5, 0.2));
		expect(cmd.expressionWeight.expression).toBe("happy");
		expect(cmd.expressionWeight.weight).toBeCloseTo(0.8);
		expect(cmd.animation).toBe("happy");
		expect(cmd.animationIntensity).toBeCloseTo(0.7);
	});

	it("AvatarCommand allows optional animation fields", async () => {
		const stubController: AvatarController = {
			applyEmotion(_emotion: Emotion): Promise<AvatarCommand> {
				return Promise.resolve({
					expressionWeight: { expression: "neutral", weight: 1.0 },
				});
			},
			playAnimation(): Promise<void> {
				return Promise.resolve();
			},
		};

		const cmd = await stubController.applyEmotion(NEUTRAL_EMOTION);
		expect(cmd.expressionWeight.expression).toBe("neutral");
		expect(cmd.animation).toBeUndefined();
		expect(cmd.animationIntensity).toBeUndefined();
	});

	it("defines playAnimation that accepts preset and intensity", async () => {
		let calledWith: { preset: string; intensity: number } | undefined;
		const stubController: AvatarController = {
			applyEmotion(_emotion: Emotion): Promise<AvatarCommand> {
				return Promise.resolve({ expressionWeight: { expression: "neutral", weight: 1.0 } });
			},
			playAnimation(preset, intensity): Promise<void> {
				calledWith = { preset, intensity };
				return Promise.resolve();
			},
		};

		await stubController.playAnimation("wave", 0.6);
		expect(calledWith).toEqual({ preset: "wave", intensity: 0.6 });
	});
});

// ─── GatewayPort (type contract) ────────────────────────────────

describe("GatewayPort", () => {
	const NOW = "2026-03-17T00:00:00.000Z";

	const sampleServerMessage: ServerMessage = {
		type: "chat_message",
		status: "complete",
		text: "こんにちは",
		messageId: "msg-001",
		timestamp: NOW,
	};

	const sampleClientMessage: ClientMessage = {
		type: "chat_input",
		text: "やっほー",
		timestamp: NOW,
	};

	function createStubGateway(): GatewayPort & {
		sentMessages: Array<{ connectionId: ConnectionId; message: ServerMessage }>;
		broadcastedMessages: ServerMessage[];
		handlers: ClientMessageHandler[];
	} {
		const sentMessages: Array<{ connectionId: ConnectionId; message: ServerMessage }> = [];
		const broadcastedMessages: ServerMessage[] = [];
		const handlers: ClientMessageHandler[] = [];

		return {
			sentMessages,
			broadcastedMessages,
			handlers,
			send(connectionId: ConnectionId, message: ServerMessage) {
				sentMessages.push({ connectionId, message });
			},
			broadcast(message: ServerMessage) {
				broadcastedMessages.push(message);
			},
			onMessage(handler: ClientMessageHandler) {
				handlers.push(handler);
			},
			getConnectionCount() {
				return 2;
			},
		};
	}

	it("defines send that targets a specific connection", () => {
		const gw = createStubGateway();
		gw.send("conn-1", sampleServerMessage);

		expect(gw.sentMessages).toHaveLength(1);
		expect(gw.sentMessages[0]?.connectionId).toBe("conn-1");
		expect(gw.sentMessages[0]?.message.type).toBe("chat_message");
	});

	it("defines broadcast that sends to all connections", () => {
		const gw = createStubGateway();
		gw.broadcast(sampleServerMessage);

		expect(gw.broadcastedMessages).toHaveLength(1);
		expect(gw.broadcastedMessages[0]?.type).toBe("chat_message");
	});

	it("defines onMessage that registers a client message handler", () => {
		const gw = createStubGateway();
		gw.onMessage((_connId, _msg) => {});

		expect(gw.handlers).toHaveLength(1);
	});

	it("handler receives connectionId and ClientMessage", () => {
		const gw = createStubGateway();
		let receivedConnId: ConnectionId | undefined;
		let receivedMsg: ClientMessage | undefined;

		gw.onMessage((connId, msg) => {
			receivedConnId = connId;
			receivedMsg = msg;
		});

		// Simulate message reception
		for (const handler of gw.handlers) {
			handler("conn-42", sampleClientMessage);
		}

		expect(receivedConnId).toBe("conn-42");
		expect(receivedMsg?.type).toBe("chat_input");
	});

	it("defines getConnectionCount that returns a number", () => {
		const gw = createStubGateway();
		expect(gw.getConnectionCount()).toBe(2);
	});
});

// ─── AgentResponse.emotion (type contract) ──────────────────────

describe("AgentResponse with emotion", () => {
	it("accepts emotion as an optional field", () => {
		// Without emotion (backward compatible)
		const responseWithout: AgentResponse = {
			text: "こんにちは",
			sessionId: "sess-1",
		};
		expect(responseWithout.emotion).toBeUndefined();

		// With emotion
		const responseWith: AgentResponse = {
			text: "やったー！",
			sessionId: "sess-1",
			emotion: createEmotion(0.8, 0.5, 0.2),
		};
		expect(responseWith.emotion).toBeDefined();
		expect(responseWith.emotion?.valence).toBeCloseTo(0.8);
		expect(responseWith.emotion?.arousal).toBeCloseTo(0.5);
		expect(responseWith.emotion?.dominance).toBeCloseTo(0.2);
	});
});
