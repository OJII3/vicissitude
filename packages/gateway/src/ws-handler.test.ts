import { type mock, describe, expect, it, spyOn } from "bun:test";

import type { EmotionToTtsStyleMapper, TtsSynthesizer } from "@vicissitude/shared/ports";
import { createMockLogger } from "@vicissitude/shared/test-helpers";
import { createTtsStyleParams } from "@vicissitude/shared/tts";
import type { ServerMessage } from "@vicissitude/shared/ws-protocol";

import { WsConnectionManager, type WebSocketConnection } from "./ws-handler.ts";

// ─── Helpers ────────────────────────────────────────────────────

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
			const manager = new WsConnectionManager();
			let handlerCalled = false;
			manager.onMessage(() => {
				handlerCalled = true;
			});

			// handleOpen せずに handleMessage を呼ぶ
			manager.handleMessage("nonexistent", JSON.stringify(validChatInput));

			expect(handlerCalled).toBe(false);
		});

		it("接続が見つからない場合、エラーメッセージも送信されない", () => {
			const manager = new WsConnectionManager();
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
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", "not json");

			const errorMsg = JSON.parse(conn.sent[0] as string);
			expect(errorMsg.code).toBe("INVALID_MESSAGE");
			expect(errorMsg.message).toBe("Failed to parse client message");
		});

		it("パース失敗時、ErrorMessage に timestamp が含まれる", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", "bad");

			const errorMsg = JSON.parse(conn.sent[0] as string);
			expect(errorMsg.timestamp).toBeDefined();
			// ISO 8601 形式であることを確認
			expect(new Date(errorMsg.timestamp).toISOString()).toBe(errorMsg.timestamp);
		});
	});

	// ─── broadcast: JSON.stringify 最適化 ───────────────────────

	describe("broadcast - JSON.stringify 最適化", () => {
		it("接続数にかかわらず JSON.stringify が1回だけ呼ばれる", () => {
			const stringifySpy = spyOn(JSON, "stringify");

			const manager = new WsConnectionManager();
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
			const manager = new WsConnectionManager();
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
			const manager = new WsConnectionManager({ logger });
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
			const errorCalls = (logger.error as ReturnType<typeof mock>).mock.calls;
			expect(errorCalls).toHaveLength(1);
			expect(errorCalls[0]?.[0]).toBe("[gateway] Message handler threw an exception");
			const detail = errorCalls[0]?.[1] as Record<string, unknown>;
			expect(detail.connectionId).toBe("conn-1");
			expect(detail.messageType).toBe("chat_input");
			expect(detail.error).toBeInstanceOf(Error);
		});

		it("先行ハンドラが例外を投げても、後続ハンドラは呼ばれる", () => {
			const logger = createMockLogger();
			const manager = new WsConnectionManager({ logger });
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

		it("deps 省略時、既存動作が変わらない（ChatResponseMessage + EmotionUpdateMessage のみ）", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			// chat_message + emotion_update の2つだけ
			expect(conn.sent).toHaveLength(2);
			const msg0 = JSON.parse(conn.sent[0] as string);
			const msg1 = JSON.parse(conn.sent[1] as string);
			expect(msg0.type).toBe("chat_message");
			expect(msg1.type).toBe("emotion_update");
		});

		it("TTS 合成成功時、AudioDataMessage が送信される", async () => {
			const manager = new WsConnectionManager({
				ttsSynthesizer: mockSynthesizer,
				ttsStyleMapper: mockStyleMapper,
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
			const manager = new WsConnectionManager({
				ttsSynthesizer: mockSynthesizer,
				ttsStyleMapper: mockStyleMapper,
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

			const parsed = JSON.parse(audioMsg as string);
			const decoded = Buffer.from(parsed.audio, "base64");
			expect(new Uint8Array(decoded)).toEqual(dummyAudio);
		});

		it("TTS 合成が null を返した場合、AudioDataMessage は送信されない", async () => {
			const nullSynthesizer: TtsSynthesizer = {
				synthesize: () => Promise.resolve(null),
				isAvailable: () => Promise.resolve(true),
			};
			const manager = new WsConnectionManager({
				ttsSynthesizer: nullSynthesizer,
				ttsStyleMapper: mockStyleMapper,
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
			const manager = new WsConnectionManager({
				ttsSynthesizer: failingSynthesizer,
				ttsStyleMapper: mockStyleMapper,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			// テキスト応答は即座に返る
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
			const manager = new WsConnectionManager({
				ttsStyleMapper: mockStyleMapper,
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
			const manager = new WsConnectionManager({
				ttsSynthesizer: mockSynthesizer,
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
