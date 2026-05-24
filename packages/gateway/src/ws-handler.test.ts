import { describe, expect, it, mock, spyOn } from "bun:test";

import type {
	EmotionToExpressionMapper,
	EmotionToTtsStyleMapper,
	TtsSynthesizer,
} from "@vicissitude/shared/ports";
import { createMockLogger } from "@vicissitude/shared/test-helpers";
import { createTtsStyleParams } from "@vicissitude/shared/tts";
import type { ServerMessage } from "@vicissitude/shared/ws-protocol";

import {
	CHAT_INPUT_MAX_LENGTH,
	CHAT_INPUT_MIN_INTERVAL_MS,
	WsConnectionManager,
	type WebSocketConnection,
	type WsConnectionManagerDeps,
} from "./ws-handler.ts";

// ─── Helpers ────────────────────────────────────────────────────

const noopLogger = createMockLogger();
const mockExpressionMapper: EmotionToExpressionMapper = {
	mapToExpression: () => ({ expression: "neutral", weight: 1.0 }),
};
type TestManagerDeps = Omit<
	WsConnectionManagerDeps,
	"emotionToExpressionMapper" | "chatResponder"
> &
	Partial<Pick<WsConnectionManagerDeps, "emotionToExpressionMapper" | "chatResponder">>;

function createManager(deps?: TestManagerDeps): WsConnectionManager {
	return new WsConnectionManager({
		emotionToExpressionMapper: mockExpressionMapper,
		chatResponder: {
			respond: ({ text }) => Promise.resolve({ text }),
		},
		logger: noopLogger,
		...deps,
	});
}

function createMockConnection(): WebSocketConnection & { sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		send(data: string) {
			sent.push(data);
		},
	};
}

const NOW = "2026-03-17T00:00:00.000Z";

const validChatInput = {
	type: "chat_input" as const,
	text: "hello",
	timestamp: NOW,
};

const sampleServerMessage: ServerMessage = {
	type: "chat_message",
	status: "complete",
	text: "hi",
	messageId: "msg-001",
	timestamp: NOW,
};

// ─── handleMessage: 存在しない connectionId ─────────────────────

describe("WsConnectionManager (unit)", () => {
	describe("handleMessage - 存在しない connectionId", () => {
		it("接続が見つからない場合、ハンドラは呼ばれず早期リターンする", () => {
			const manager = createManager({ logger: noopLogger });
			let handlerCalled = false;
			manager.onMessage(() => {
				handlerCalled = true;
			});

			// handleOpen せずに handleMessage を呼ぶ
			manager.handleMessage("nonexistent", JSON.stringify(validChatInput));

			expect(handlerCalled).toBe(false);
		});

		it("接続が見つからない場合、エラーメッセージも送信されない", () => {
			const manager = createManager({ logger: noopLogger });
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			// conn-1 は存在するが conn-2 は存在しない
			manager.handleMessage("conn-2", "invalid json");

			// conn-1 にはエラーが送られていない（conn-2 宛だが接続なし）
			expect(conn.sent).toHaveLength(0);
		});
	});

	// ─── handleMessage: エラーメッセージの詳細 ──────────────────

	describe("handleMessage - エラーレスポンスの内容", () => {
		it("パース失敗時、ErrorMessage の code が INVALID_MESSAGE である", () => {
			const manager = createManager({ logger: noopLogger });
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", "not json");

			const errorMsg = JSON.parse(conn.sent[0] as string) as { code: string; message: string };
			expect(errorMsg.code).toBe("INVALID_MESSAGE");
			expect(errorMsg.message).toBe("Failed to parse client message");
		});

		it("パース失敗時、ErrorMessage に timestamp が含まれる", () => {
			const manager = createManager({ logger: noopLogger });
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", "bad");

			const errorMsg = JSON.parse(conn.sent[0] as string) as { timestamp: string };
			expect(errorMsg.timestamp).toBeDefined();
			// ISO 8601 形式であることを確認
			expect(new Date(errorMsg.timestamp).toISOString()).toBe(errorMsg.timestamp);
		});
	});

	// ─── broadcast: JSON.stringify 最適化 ───────────────────────

	describe("broadcast - JSON.stringify 最適化", () => {
		it("接続数にかかわらず JSON.stringify が1回だけ呼ばれる", () => {
			const stringifySpy = spyOn(JSON, "stringify");

			const manager = createManager({ logger: noopLogger });
			manager.handleOpen("conn-1", createMockConnection());
			manager.handleOpen("conn-2", createMockConnection());
			manager.handleOpen("conn-3", createMockConnection());

			// spy を設定してからカウントをリセット
			stringifySpy.mockClear();

			manager.broadcast(sampleServerMessage);

			expect(stringifySpy).toHaveBeenCalledTimes(1);

			stringifySpy.mockRestore();
		});

		it("全接続に同一の文字列インスタンスが送信される", () => {
			const manager = createManager({ logger: noopLogger });
			const conn1 = createMockConnection();
			const conn2 = createMockConnection();
			const conn3 = createMockConnection();
			manager.handleOpen("conn-1", conn1);
			manager.handleOpen("conn-2", conn2);
			manager.handleOpen("conn-3", conn3);

			manager.broadcast(sampleServerMessage);

			// 全接続が同一の文字列参照を受け取っていることを確認
			// (=== で比較して、シリアライズが1回であることを間接的に検証)
			expect(conn1.sent[0]).toBe(conn2.sent[0]);
			expect(conn2.sent[0]).toBe(conn3.sent[0]);
		});
	});

	// ─── handleMessage: ハンドラ例外の影響 ──────────────────────

	describe("handleMessage - ハンドラ内例外", () => {
		it("ハンドラが例外を投げても外に伝播せず、Logger.error でログが出力される", () => {
			const logger = createMockLogger();
			const manager = createManager({ logger });
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.onMessage(() => {
				throw new Error("handler error");
			});

			// 例外は外に伝播しない
			expect(() => manager.handleMessage("conn-1", JSON.stringify(validChatInput))).not.toThrow();

			// INVALID_MESSAGE エラーメッセージは送信されない（パースは成功しているため）
			const errorMessages = conn.sent.filter((s) => {
				const parsed = JSON.parse(s);
				return parsed.type === "error";
			});
			expect(errorMessages).toHaveLength(0);

			// Logger.error が呼ばれる
			const errorCalls = logger.error.mock.calls;
			expect(errorCalls).toHaveLength(1);
			expect(errorCalls[0]?.[0]).toBe("[gateway] Message handler threw an exception");
			const detail = errorCalls[0]?.[1] as Record<string, unknown>;
			expect(detail.connectionId).toBe("conn-1");
			expect(detail.messageType).toBe("chat_input");
			expect(detail.error).toBeInstanceOf(Error);
		});

		it("先行ハンドラが例外を投げても、後続ハンドラは呼ばれる", () => {
			const logger = createMockLogger();
			const manager = createManager({ logger });
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			let secondCalled = false;

			manager.onMessage(() => {
				throw new Error("first handler fails");
			});
			manager.onMessage(() => {
				secondCalled = true;
			});

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			// 先行ハンドラの例外にかかわらず後続ハンドラが実行される
			expect(secondCalled).toBe(true);
		});
	});

	// ─── TTS 統合 ────────────────────────────────────────────────

	describe("TTS 統合", () => {
		const dummyAudio = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

		const mockStyleMapper: EmotionToTtsStyleMapper = {
			mapToStyle: () => createTtsStyleParams("happy", 0.8, 1.0),
		};

		const mockSynthesizer: TtsSynthesizer = {
			synthesize: () =>
				Promise.resolve({
					audio: dummyAudio,
					format: "wav" as const,
					durationSec: 2.0,
				}),
			isAvailable: () => Promise.resolve(true),
		};

		it("chatResponder の応答から ChatResponseMessage + EmotionUpdateMessage を送る", async () => {
			const manager = createManager({ logger: noopLogger });
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));
			await Bun.sleep(0);

			// chat_message + emotion_update の2つだけ
			expect(conn.sent).toHaveLength(2);
			const msg0 = JSON.parse(conn.sent[0] as string);
			const msg1 = JSON.parse(conn.sent[1] as string);
			expect(msg0.type).toBe("chat_message");
			expect(msg0.text).toBe("hello");
			expect(msg1.type).toBe("emotion_update");
		});

		it("chatResponder の応答テキストは入力文のエコーに限定されない", async () => {
			const manager = createManager({
				chatResponder: {
					respond: () => Promise.resolve({ text: "LLM response" }),
				},
				logger: noopLogger,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));
			await Bun.sleep(0);

			const chatMsg = JSON.parse(conn.sent[0] as string);
			expect(chatMsg.type).toBe("chat_message");
			expect(chatMsg.text).toBe("LLM response");
		});

		it("TTS 合成成功時、AudioDataMessage が送信される", async () => {
			const manager = createManager({
				ttsSynthesizer: mockSynthesizer,
				ttsStyleMapper: mockStyleMapper,
				logger: noopLogger,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			// fire-and-forget の非同期処理を待つ
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const audioMsg = conn.sent.find((s) => {
				const parsed = JSON.parse(s);
				return parsed.type === "audio_data";
			});
			expect(audioMsg).toBeDefined();

			const parsed = JSON.parse(audioMsg as string);
			expect(parsed.type).toBe("audio_data");
			expect(parsed.format).toBe("wav");
			expect(parsed.durationSec).toBe(2.0);
		});

		it("AudioDataMessage の audio フィールドが base64 エンコードされている", async () => {
			const manager = createManager({
				ttsSynthesizer: mockSynthesizer,
				ttsStyleMapper: mockStyleMapper,
				logger: noopLogger,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const audioMsg = conn.sent.find((s) => {
				const parsed = JSON.parse(s);
				return parsed.type === "audio_data";
			});
			expect(audioMsg).toBeDefined();

			const parsed = JSON.parse(audioMsg as string) as { audio: string };
			const decoded = Buffer.from(parsed.audio, "base64");
			expect(new Uint8Array(decoded)).toEqual(dummyAudio);
		});

		it("TTS 合成が null を返した場合、AudioDataMessage は送信されない", async () => {
			const nullSynthesizer: TtsSynthesizer = {
				synthesize: () => Promise.resolve(null),
				isAvailable: () => Promise.resolve(true),
			};
			const manager = createManager({
				ttsSynthesizer: nullSynthesizer,
				ttsStyleMapper: mockStyleMapper,
				logger: noopLogger,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const hasAudio = conn.sent.some((s) => {
				const parsed = JSON.parse(s);
				return parsed.type === "audio_data";
			});
			expect(hasAudio).toBe(false);
		});

		it("TTS 合成が reject した場合、エラーは握りつぶされテキスト応答は正常に返る", async () => {
			const failingSynthesizer: TtsSynthesizer = {
				synthesize: () => Promise.reject(new Error("TTS service unavailable")),
				isAvailable: () => Promise.resolve(false),
			};
			const manager = createManager({
				ttsSynthesizer: failingSynthesizer,
				ttsStyleMapper: mockStyleMapper,
				logger: noopLogger,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			// テキスト応答は即座に返る
			await Bun.sleep(0);
			const chatMsg = JSON.parse(conn.sent[0] as string);
			expect(chatMsg.type).toBe("chat_message");
			expect(chatMsg.text).toBe("hello");

			// 非同期処理を待っても AudioDataMessage は送信されない
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const hasAudio = conn.sent.some((s) => {
				const parsed = JSON.parse(s);
				return parsed.type === "audio_data";
			});
			expect(hasAudio).toBe(false);
		});

		it("ttsStyleMapper のみ設定して ttsSynthesizer がない場合、TTS は実行されない", async () => {
			const manager = createManager({
				ttsStyleMapper: mockStyleMapper,
				logger: noopLogger,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			// chat_message + emotion_update のみ
			expect(conn.sent).toHaveLength(2);
		});

		it("ttsSynthesizer のみ設定して ttsStyleMapper がない場合、TTS は実行されない", async () => {
			const manager = createManager({
				ttsSynthesizer: mockSynthesizer,
				logger: noopLogger,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			// chat_message + emotion_update のみ
			expect(conn.sent).toHaveLength(2);
		});
	});
});

describe("WsConnectionManager chat_input limits", () => {
	it("最大長を超える入力は chatResponder に渡さず拒否する", () => {
		const respond = mock(() => Promise.resolve({ text: "no" }));
		const manager = createManager({ chatResponder: { respond }, logger: noopLogger });
		const conn = createMockConnection();
		manager.handleOpen("conn-1", conn);

		manager.handleMessage(
			"conn-1",
			JSON.stringify({ ...validChatInput, text: "x".repeat(CHAT_INPUT_MAX_LENGTH + 1) }),
		);

		expect(respond).not.toHaveBeenCalled();
		const errorMsg = JSON.parse(conn.sent[0] as string) as { code: string };
		expect(errorMsg.code).toBe("CHAT_INPUT_TOO_LONG");
	});

	it("同じ接続で応答中の追加入力は chatResponder に渡さない", async () => {
		let resolveResponse: ((value: { text: string }) => void) | undefined;
		const respond = mock(
			() =>
				new Promise<{ text: string }>((resolve) => {
					resolveResponse = resolve;
				}),
		);
		const manager = createManager({ chatResponder: { respond }, logger: noopLogger });
		const conn = createMockConnection();
		manager.handleOpen("conn-1", conn);

		manager.handleMessage("conn-1", JSON.stringify(validChatInput));
		manager.handleMessage("conn-1", JSON.stringify({ ...validChatInput, text: "again" }));

		expect(respond).toHaveBeenCalledTimes(1);
		const errorMsg = JSON.parse(conn.sent[0] as string) as { code: string };
		expect(errorMsg.code).toBe("CHAT_RESPONSE_IN_PROGRESS");

		resolveResponse?.({ text: "done" });
		await Bun.sleep(0);
	});

	it("同じ接続の短時間連投は chatResponder に渡さない", async () => {
		let now = 20_000;
		const respond = mock(({ text }: { text: string }) => Promise.resolve({ text }));
		const manager = createManager({
			chatResponder: { respond },
			logger: noopLogger,
			nowProvider: () => now,
		});
		const conn = createMockConnection();
		manager.handleOpen("conn-1", conn);

		manager.handleMessage("conn-1", JSON.stringify(validChatInput));
		await Bun.sleep(0);
		now += CHAT_INPUT_MIN_INTERVAL_MS - 1;
		manager.handleMessage("conn-1", JSON.stringify({ ...validChatInput, text: "again" }));

		expect(respond).toHaveBeenCalledTimes(1);
		const errorMsg = conn.sent
			.map((s) => JSON.parse(s) as { type: string; code?: string })
			.find((message) => message.type === "error");
		expect(errorMsg?.code).toBe("CHAT_RATE_LIMITED");
	});
});
