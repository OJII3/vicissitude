import { describe, expect, it } from "bun:test";

import type {
	AnimationCommandMessage,
	BodyAnimationPreset,
	ChatInputMessage,
	ChatResponseMessage,
	ClientMessage,
	EmotionUpdateMessage,
	ErrorMessage,
	ServerMessage,
	WsMessage,
} from "@vicissitude/shared/ws-protocol";
import {
	AnimationCommandMessageSchema,
	BodyAnimationPresetSchema,
	ChatInputMessageSchema,
	ChatResponseMessageSchema,
	ClientMessageSchema,
	EmotionUpdateMessageSchema,
	ErrorMessageSchema,
	ServerMessageSchema,
	WsMessageSchema,
	parseClientMessage,
	parseServerMessage,
} from "@vicissitude/shared/ws-protocol";
import { ZodError } from "zod";

// ─── Test Fixtures ──────────────────────────────────────────────

const NOW = "2026-03-17T00:00:00.000Z";

const validEmotionUpdate: EmotionUpdateMessage = {
	type: "emotion_update",
	emotion: { valence: 0.8, arousal: 0.3, dominance: 0.1 },
	expressionWeight: { expression: "happy", weight: 0.9 },
	timestamp: NOW,
};

const validChatMessageChunk: ChatResponseMessage = {
	type: "chat_message",
	status: "chunk",
	text: "やっ",
	messageId: "msg-001",
	timestamp: NOW,
};

const validChatMessageComplete: ChatResponseMessage = {
	type: "chat_message",
	status: "complete",
	text: "やったー！",
	messageId: "msg-001",
	timestamp: NOW,
};

const validAnimationCommand: AnimationCommandMessage = {
	type: "animation_command",
	preset: "happy",
	intensity: 0.8,
	timestamp: NOW,
};

const validError: ErrorMessage = {
	type: "error",
	code: "AGENT_TIMEOUT",
	message: "Agent did not respond in time",
	timestamp: NOW,
};

const validChatInput: ChatInputMessage = {
	type: "chat_input",
	text: "こんにちは",
	timestamp: NOW,
};

// ─── BodyAnimationPresetSchema ──────────────────────────────────

describe("BodyAnimationPresetSchema", () => {
	const validPresets: BodyAnimationPreset[] = [
		"idle",
		"thinking",
		"happy",
		"angry",
		"sad",
		"wave",
		"nod",
	];

	it("accepts all valid presets", () => {
		for (const preset of validPresets) {
			expect(BodyAnimationPresetSchema.parse(preset)).toBe(preset);
		}
	});

	it("rejects invalid preset names", () => {
		expect(() => BodyAnimationPresetSchema.parse("dance")).toThrow();
		expect(() => BodyAnimationPresetSchema.parse("")).toThrow();
		expect(() => BodyAnimationPresetSchema.parse(42)).toThrow();
	});
});

// ─── EmotionUpdateMessage ───────────────────────────────────────

describe("EmotionUpdateMessageSchema", () => {
	it("parses a valid emotion update", () => {
		const result = EmotionUpdateMessageSchema.parse(validEmotionUpdate);
		expect(result.type).toBe("emotion_update");
		expect(result.emotion.valence).toBeCloseTo(0.8);
		expect(result.expressionWeight.expression).toBe("happy");
		expect(result.expressionWeight.weight).toBeCloseTo(0.9);
	});

	it("clamps out-of-range emotion values via EmotionSchema transform", () => {
		const msg = {
			...validEmotionUpdate,
			emotion: { valence: 2, arousal: -3, dominance: 0.5 },
		};
		const result = EmotionUpdateMessageSchema.parse(msg);
		expect(result.emotion.valence).toBe(1);
		expect(result.emotion.arousal).toBe(-1);
	});

	it("rejects invalid expression in expressionWeight", () => {
		const msg = {
			...validEmotionUpdate,
			expressionWeight: { expression: "disgust", weight: 0.5 },
		};
		expect(() => EmotionUpdateMessageSchema.parse(msg)).toThrow();
	});

	it("rejects invalid timestamp format", () => {
		const msg = { ...validEmotionUpdate, timestamp: "not-a-date" };
		expect(() => EmotionUpdateMessageSchema.parse(msg)).toThrow();
	});

	it("rejects missing fields", () => {
		expect(() => EmotionUpdateMessageSchema.parse({ type: "emotion_update" })).toThrow();
	});
});

// ─── ChatResponseMessage ─────────────────────────────────────────

describe("ChatResponseMessageSchema", () => {
	it("parses a chunk message", () => {
		const result = ChatResponseMessageSchema.parse(validChatMessageChunk);
		expect(result.type).toBe("chat_message");
		expect(result.status).toBe("chunk");
		expect(result.text).toBe("やっ");
	});

	it("parses a complete message", () => {
		const result = ChatResponseMessageSchema.parse(validChatMessageComplete);
		expect(result.status).toBe("complete");
		expect(result.text).toBe("やったー！");
	});

	it("allows empty text for chunk (incremental streaming)", () => {
		const msg = { ...validChatMessageChunk, text: "" };
		expect(() => ChatResponseMessageSchema.parse(msg)).not.toThrow();
	});

	it("rejects invalid status value", () => {
		const msg = { ...validChatMessageChunk, status: "partial" };
		expect(() => ChatResponseMessageSchema.parse(msg)).toThrow();
	});

	it("rejects empty messageId", () => {
		const msg = { ...validChatMessageChunk, messageId: "" };
		expect(() => ChatResponseMessageSchema.parse(msg)).toThrow();
	});
});

// ─── AnimationCommandMessage ────────────────────────────────────

describe("AnimationCommandMessageSchema", () => {
	it("parses a valid animation command", () => {
		const result = AnimationCommandMessageSchema.parse(validAnimationCommand);
		expect(result.type).toBe("animation_command");
		expect(result.preset).toBe("happy");
		expect(result.intensity).toBeCloseTo(0.8);
	});

	it("accepts intensity at boundaries (0 and 1)", () => {
		expect(
			AnimationCommandMessageSchema.parse({ ...validAnimationCommand, intensity: 0 }).intensity,
		).toBe(0);
		expect(
			AnimationCommandMessageSchema.parse({ ...validAnimationCommand, intensity: 1 }).intensity,
		).toBe(1);
	});

	it("rejects intensity outside [0, 1]", () => {
		expect(() =>
			AnimationCommandMessageSchema.parse({ ...validAnimationCommand, intensity: -0.1 }),
		).toThrow();
		expect(() =>
			AnimationCommandMessageSchema.parse({ ...validAnimationCommand, intensity: 1.1 }),
		).toThrow();
	});

	it("rejects invalid preset", () => {
		expect(() =>
			AnimationCommandMessageSchema.parse({ ...validAnimationCommand, preset: "dance" }),
		).toThrow();
	});
});

// ─── ErrorMessage ───────────────────────────────────────────────

describe("ErrorMessageSchema", () => {
	it("parses a valid error message", () => {
		const result = ErrorMessageSchema.parse(validError);
		expect(result.type).toBe("error");
		expect(result.code).toBe("AGENT_TIMEOUT");
		expect(result.message).toBe("Agent did not respond in time");
	});

	it("rejects empty error code", () => {
		expect(() => ErrorMessageSchema.parse({ ...validError, code: "" })).toThrow();
	});

	it("allows empty error message string", () => {
		expect(() => ErrorMessageSchema.parse({ ...validError, message: "" })).not.toThrow();
	});
});

// ─── ChatInputMessage ───────────────────────────────────────────

describe("ChatInputMessageSchema", () => {
	it("parses a valid chat input", () => {
		const result = ChatInputMessageSchema.parse(validChatInput);
		expect(result.type).toBe("chat_input");
		expect(result.text).toBe("こんにちは");
	});

	it("rejects empty text", () => {
		expect(() => ChatInputMessageSchema.parse({ ...validChatInput, text: "" })).toThrow();
	});

	it("rejects missing timestamp", () => {
		expect(() => ChatInputMessageSchema.parse({ type: "chat_input", text: "hi" })).toThrow();
	});
});

// ─── ServerMessageSchema (discriminated union) ──────────────────

describe("ServerMessageSchema", () => {
	it("dispatches emotion_update correctly", () => {
		const result = ServerMessageSchema.parse(validEmotionUpdate);
		expect(result.type).toBe("emotion_update");
	});

	it("dispatches chat_message correctly", () => {
		const result = ServerMessageSchema.parse(validChatMessageComplete);
		expect(result.type).toBe("chat_message");
	});

	it("dispatches animation_command correctly", () => {
		const result = ServerMessageSchema.parse(validAnimationCommand);
		expect(result.type).toBe("animation_command");
	});

	it("dispatches error correctly", () => {
		const result = ServerMessageSchema.parse(validError);
		expect(result.type).toBe("error");
	});

	it("rejects unknown message type", () => {
		expect(() => ServerMessageSchema.parse({ type: "unknown", timestamp: NOW })).toThrow();
	});

	it("rejects client-only message types", () => {
		expect(() => ServerMessageSchema.parse(validChatInput)).toThrow();
	});
});

// ─── ClientMessageSchema (discriminated union) ──────────────────

describe("ClientMessageSchema", () => {
	it("dispatches chat_input correctly", () => {
		const result = ClientMessageSchema.parse(validChatInput);
		expect(result.type).toBe("chat_input");
	});

	it("rejects server-only message types", () => {
		expect(() => ClientMessageSchema.parse(validEmotionUpdate)).toThrow();
		expect(() => ClientMessageSchema.parse(validChatMessageComplete)).toThrow();
	});
});

// ─── WsMessageSchema (full union) ──────────────────────────────

describe("WsMessageSchema", () => {
	it("accepts all valid server message types", () => {
		expect(WsMessageSchema.parse(validEmotionUpdate).type).toBe("emotion_update");
		expect(WsMessageSchema.parse(validChatMessageComplete).type).toBe("chat_message");
		expect(WsMessageSchema.parse(validAnimationCommand).type).toBe("animation_command");
		expect(WsMessageSchema.parse(validError).type).toBe("error");
	});

	it("accepts all valid client message types", () => {
		expect(WsMessageSchema.parse(validChatInput).type).toBe("chat_input");
	});

	it("rejects unknown types", () => {
		expect(() => WsMessageSchema.parse({ type: "ping", timestamp: NOW })).toThrow();
	});
});

// ─── parseServerMessage ─────────────────────────────────────────

describe("parseServerMessage", () => {
	it("parses valid JSON into a ServerMessage", () => {
		const raw = JSON.stringify(validEmotionUpdate);
		const result = parseServerMessage(raw);
		expect(result.type).toBe("emotion_update");
	});

	it("throws ZodError on invalid JSON", () => {
		expect(() => parseServerMessage("not json")).toThrow(ZodError);
	});

	it("throws on valid JSON but invalid message", () => {
		expect(() =>
			parseServerMessage(JSON.stringify({ type: "chat_input", text: "hi", timestamp: NOW })),
		).toThrow();
	});
});

// ─── parseClientMessage ─────────────────────────────────────────

describe("parseClientMessage", () => {
	it("parses valid JSON into a ClientMessage", () => {
		const raw = JSON.stringify(validChatInput);
		const result = parseClientMessage(raw);
		expect(result.type).toBe("chat_input");
	});

	it("throws ZodError on invalid JSON", () => {
		expect(() => parseClientMessage("not json")).toThrow(ZodError);
	});

	it("throws on valid JSON but server message type", () => {
		expect(() => parseClientMessage(JSON.stringify(validEmotionUpdate))).toThrow();
	});
});

// ─── Type-level contract tests ──────────────────────────────────

describe("Type contracts", () => {
	it("ServerMessage discriminated union narrows correctly", () => {
		const messages: ServerMessage[] = [
			validEmotionUpdate,
			validChatMessageComplete,
			validAnimationCommand,
			validError,
		];
		for (const msg of messages) {
			switch (msg.type) {
				case "emotion_update":
					expect(msg.emotion).toBeDefined();
					break;
				case "chat_message":
					expect(msg.status).toBeDefined();
					break;
				case "animation_command":
					expect(msg.preset).toBeDefined();
					break;
				case "error":
					expect(msg.code).toBeDefined();
					break;
			}
		}
	});

	it("ClientMessage discriminated union narrows correctly", () => {
		const msg: ClientMessage = validChatInput;
		switch (msg.type) {
			case "chat_input":
				expect(msg.text).toBeDefined();
				break;
		}
	});

	it("WsMessage covers both server and client messages", () => {
		const messages: WsMessage[] = [
			validEmotionUpdate,
			validChatMessageComplete,
			validAnimationCommand,
			validError,
			validChatInput,
		];
		expect(messages).toHaveLength(5);
	});
});
