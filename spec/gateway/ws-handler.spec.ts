/* oxlint-disable max-lines-per-function -- spec file with setup helpers and comprehensive test suite */
import { describe, expect, it } from "bun:test";

import { WsConnectionManager } from "@vicissitude/gateway/ws-handler";
import type { EmotionToTtsStyleMapper, TtsSynthesizer } from "@vicissitude/shared/ports";
import { createTtsStyleParams, type TtsResult } from "@vicissitude/shared/tts";
import type {
	AudioDataMessage,
	ChatInputMessage,
	ChatResponseMessage,
	ErrorMessage,
	ServerMessage,
} from "@vicissitude/shared/ws-protocol";

// ─── WebSocketConnection Mock ───────────────────────────────────
//
// WsConnectionManager が内部で使う WebSocket 抽象。
// テストではこのインターフェースをモックして振る舞いを検証する。

interface WebSocketConnection {
	send(data: string): void;
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

// ─── Test Fixtures ──────────────────────────────────────────────

const NOW = "2026-03-17T00:00:00.000Z";

const validChatInput: ChatInputMessage = {
	type: "chat_input",
	text: "こんにちは",
	timestamp: NOW,
};

const sampleServerMessage: ServerMessage = {
	type: "chat_message",
	status: "complete",
	text: "やったー！",
	messageId: "msg-001",
	timestamp: NOW,
};

const sampleEmotionUpdate: ServerMessage = {
	type: "emotion_update",
	emotion: { valence: 0.8, arousal: 0.3, dominance: 0.1 },
	expressionWeight: { expression: "happy", weight: 0.9 },
	timestamp: NOW,
};

// ─── 接続管理 ───────────────────────────────────────────────────

describe("WsConnectionManager", () => {
	describe("接続管理", () => {
		it("handleOpen で接続を追加すると getConnectionCount が増える", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();

			manager.handleOpen("conn-1", conn);

			expect(manager.getConnectionCount()).toBe(1);
		});

		it("複数の接続を追加すると getConnectionCount がその数を返す", () => {
			const manager = new WsConnectionManager();
			manager.handleOpen("conn-1", createMockConnection());
			manager.handleOpen("conn-2", createMockConnection());
			manager.handleOpen("conn-3", createMockConnection());

			expect(manager.getConnectionCount()).toBe(3);
		});

		it("handleClose で接続を削除すると getConnectionCount が減る", () => {
			const manager = new WsConnectionManager();
			manager.handleOpen("conn-1", createMockConnection());
			manager.handleOpen("conn-2", createMockConnection());

			manager.handleClose("conn-1");

			expect(manager.getConnectionCount()).toBe(1);
		});

		it("接続がない状態で getConnectionCount は 0 を返す", () => {
			const manager = new WsConnectionManager();
			expect(manager.getConnectionCount()).toBe(0);
		});

		it("存在しない connectionId の handleClose はエラーにならない", () => {
			const manager = new WsConnectionManager();
			expect(() => manager.handleClose("nonexistent")).not.toThrow();
		});
	});

	// ─── send ─────────────────────────────────────────────────────

	describe("send", () => {
		it("指定 connectionId の接続にメッセージが JSON 文字列として送られる", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.send("conn-1", sampleServerMessage);

			expect(conn.sent).toHaveLength(1);
			expect(JSON.parse(conn.sent[0] as string)).toEqual(sampleServerMessage);
		});

		it("他の接続には送信されない", () => {
			const manager = new WsConnectionManager();
			const conn1 = createMockConnection();
			const conn2 = createMockConnection();
			manager.handleOpen("conn-1", conn1);
			manager.handleOpen("conn-2", conn2);

			manager.send("conn-1", sampleServerMessage);

			expect(conn1.sent).toHaveLength(1);
			expect(conn2.sent).toHaveLength(0);
		});

		it("存在しない connectionId への send はエラーにならない（静かに無視）", () => {
			const manager = new WsConnectionManager();
			expect(() => manager.send("nonexistent", sampleServerMessage)).not.toThrow();
		});
	});

	// ─── broadcast ──────────────────────────────────────────────

	describe("broadcast", () => {
		it("全接続にメッセージが JSON 文字列として送られる", () => {
			const manager = new WsConnectionManager();
			const conn1 = createMockConnection();
			const conn2 = createMockConnection();
			const conn3 = createMockConnection();
			manager.handleOpen("conn-1", conn1);
			manager.handleOpen("conn-2", conn2);
			manager.handleOpen("conn-3", conn3);

			manager.broadcast(sampleEmotionUpdate);

			for (const conn of [conn1, conn2, conn3]) {
				expect(conn.sent).toHaveLength(1);
				expect(JSON.parse(conn.sent[0] as string)).toEqual(sampleEmotionUpdate);
			}
		});

		it("接続がない状態で broadcast してもエラーにならない", () => {
			const manager = new WsConnectionManager();
			expect(() => manager.broadcast(sampleServerMessage)).not.toThrow();
		});
	});

	// ─── onMessage ──────────────────────────────────────────────

	describe("onMessage", () => {
		it("登録したハンドラが parseClientMessage 通過後のメッセージで呼ばれる", () => {
			const manager = new WsConnectionManager();
			const received: { connectionId: string; message: unknown }[] = [];
			manager.onMessage((connectionId, message) => {
				received.push({ connectionId, message });
			});

			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);
			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			expect(received).toHaveLength(1);
			const first = received[0] as (typeof received)[number];
			expect(first.connectionId).toBe("conn-1");
			expect(first.message).toEqual(validChatInput);
		});

		it("複数のハンドラを登録した場合、全てが呼ばれる", () => {
			const manager = new WsConnectionManager();
			let count1 = 0;
			let count2 = 0;
			manager.onMessage(() => {
				count1++;
			});
			manager.onMessage(() => {
				count2++;
			});

			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);
			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			expect(count1).toBe(1);
			expect(count2).toBe(1);
		});
	});

	// ─── 不正メッセージ ─────────────────────────────────────────

	describe("不正メッセージ処理", () => {
		it("不正な JSON を受信すると送信元に ErrorMessage が返される", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", "not valid json");

			expect(conn.sent).toHaveLength(1);
			const errorMsg = JSON.parse(conn.sent[0] as string) as ErrorMessage;
			expect(errorMsg.type).toBe("error");
		});

		it("JSON は有効だがスキーマ違反の場合、送信元に ErrorMessage が返される", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify({ type: "unknown_type" }));

			expect(conn.sent).toHaveLength(1);
			const errorMsg = JSON.parse(conn.sent[0] as string) as ErrorMessage;
			expect(errorMsg.type).toBe("error");
		});

		it("パースエラー時の ErrorMessage の code は INVALID_MESSAGE である", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", "not valid json");

			expect(conn.sent).toHaveLength(1);
			const errorMsg = JSON.parse(conn.sent[0] as string) as ErrorMessage;
			expect(errorMsg.type).toBe("error");
			expect(errorMsg.code).toBe("INVALID_MESSAGE");
		});

		it("不正メッセージ時にハンドラは呼ばれない", () => {
			const manager = new WsConnectionManager();
			let handlerCalled = false;
			manager.onMessage(() => {
				handlerCalled = true;
			});

			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);
			manager.handleMessage("conn-1", "invalid json");

			expect(handlerCalled).toBe(false);
		});

		it("不正メッセージでも他の接続には影響しない", () => {
			const manager = new WsConnectionManager();
			const conn1 = createMockConnection();
			const conn2 = createMockConnection();
			manager.handleOpen("conn-1", conn1);
			manager.handleOpen("conn-2", conn2);

			manager.handleMessage("conn-1", "bad json");

			// ErrorMessage
			expect(conn1.sent).toHaveLength(1);
			// 影響なし
			expect(conn2.sent).toHaveLength(0);
		});
	});

	// ─── ハンドラ例外の隔離（Issue #197）─────────────────────────

	describe("ハンドラ例外の隔離", () => {
		it("ハンドラが例外を投げても INVALID_MESSAGE ErrorMessage は送信されない", () => {
			const manager = new WsConnectionManager();
			manager.onMessage(() => {
				throw new Error("handler crashed");
			});

			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);
			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			const errorMessages = conn.sent
				.map((s) => JSON.parse(s) as ServerMessage)
				.filter((m): m is ErrorMessage => m.type === "error" && m.code === "INVALID_MESSAGE");
			expect(errorMessages).toHaveLength(0);
		});

		it("先行ハンドラが例外を投げても後続ハンドラは呼ばれる", () => {
			const manager = new WsConnectionManager();
			let secondHandlerCalled = false;

			manager.onMessage(() => {
				throw new Error("first handler crashed");
			});
			manager.onMessage(() => {
				secondHandlerCalled = true;
			});

			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);
			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			expect(secondHandlerCalled).toBe(true);
		});

		it("ハンドラが例外を投げてもパース自体は成功しているのでメッセージは有効である", () => {
			const manager = new WsConnectionManager();
			const received: unknown[] = [];

			manager.onMessage(() => {
				throw new Error("first handler crashed");
			});
			manager.onMessage((_connectionId, message) => {
				received.push(message);
			});

			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);
			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			expect(received).toHaveLength(1);
			expect(received[0]).toEqual(validChatInput);
		});
	});

	// ─── TTS 統合 ──────────────────────────────────────────────────

	describe("TTS 統合", () => {
		const dummyWavAudio = new Uint8Array(44);

		const mockStyleMapper: EmotionToTtsStyleMapper = {
			mapToStyle: () => createTtsStyleParams("happy", 0.8, 1.0),
		};

		function createMockSynthesizer(result?: TtsResult | null): TtsSynthesizer {
			const r =
				result === undefined
					? { audio: dummyWavAudio, format: "wav" as const, durationSec: 1.5 }
					: result;
			return {
				synthesize: () => Promise.resolve(r),
				isAvailable: () => Promise.resolve(true),
			};
		}

		it("chat_input 受信時、TTS が利用可能な場合は AudioDataMessage が送信される", async () => {
			const manager = new WsConnectionManager({
				ttsSynthesizer: createMockSynthesizer(),
				ttsStyleMapper: mockStyleMapper,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			// TTS 合成は非同期なので少し待つ
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const messages = conn.sent.map((s) => JSON.parse(s) as ServerMessage);
			const chatMessages = messages.filter(
				(m): m is ChatResponseMessage => m.type === "chat_message",
			);
			const audioMessages = messages.filter((m): m is AudioDataMessage => m.type === "audio_data");

			expect(chatMessages.length).toBeGreaterThanOrEqual(1);
			expect(audioMessages.length).toBeGreaterThanOrEqual(1);
		});

		it("AudioDataMessage の messageId は対応する ChatResponseMessage と一致する", async () => {
			const manager = new WsConnectionManager({
				ttsSynthesizer: createMockSynthesizer(),
				ttsStyleMapper: mockStyleMapper,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const messages = conn.sent.map((s) => JSON.parse(s) as ServerMessage);
			const chatMsg = messages.find(
				(m): m is ChatResponseMessage => m.type === "chat_message" && m.status === "complete",
			);
			const audioMsg = messages.find((m): m is AudioDataMessage => m.type === "audio_data");

			expect(chatMsg).toBeDefined();
			expect(audioMsg).toBeDefined();
			if (!audioMsg || !chatMsg) throw new Error("unreachable");
			expect(audioMsg.messageId).toBe(chatMsg.messageId);
		});

		it("AudioDataMessage の format は 'wav'、audio は空でない文字列、durationSec は正の数", async () => {
			const manager = new WsConnectionManager({
				ttsSynthesizer: createMockSynthesizer(),
				ttsStyleMapper: mockStyleMapper,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const messages = conn.sent.map((s) => JSON.parse(s) as ServerMessage);
			const audioMsg = messages.find((m): m is AudioDataMessage => m.type === "audio_data");

			expect(audioMsg).toBeDefined();
			if (!audioMsg) throw new Error("unreachable");
			expect(audioMsg.format).toBe("wav");
			expect(audioMsg.audio.length).toBeGreaterThan(0);
			expect(audioMsg.durationSec).toBeGreaterThan(0);
		});

		it("TTS synthesizer 未設定時はテキスト応答のみ（AudioDataMessage なし）", async () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const messages = conn.sent.map((s) => JSON.parse(s) as ServerMessage);
			const audioMessages = messages.filter((m) => m.type === "audio_data");

			expect(audioMessages).toHaveLength(0);
		});

		it("TTS 合成が null を返した場合はテキスト応答のみ", async () => {
			const manager = new WsConnectionManager({
				ttsSynthesizer: createMockSynthesizer(null),
				ttsStyleMapper: mockStyleMapper,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const messages = conn.sent.map((s) => JSON.parse(s) as ServerMessage);
			const chatMessages = messages.filter((m) => m.type === "chat_message");
			const audioMessages = messages.filter((m) => m.type === "audio_data");

			expect(chatMessages.length).toBeGreaterThanOrEqual(1);
			expect(audioMessages).toHaveLength(0);
		});

		it("TTS 合成エラー時もテキスト応答は正常に返る", async () => {
			const failingSynthesizer: TtsSynthesizer = {
				synthesize: () => Promise.reject(new Error("TTS engine unavailable")),
				isAvailable: () => Promise.resolve(true),
			};

			const manager = new WsConnectionManager({
				ttsSynthesizer: failingSynthesizer,
				ttsStyleMapper: mockStyleMapper,
			});
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.handleMessage("conn-1", JSON.stringify(validChatInput));

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			const messages = conn.sent.map((s) => JSON.parse(s) as ServerMessage);
			const chatMessages = messages.filter(
				(m): m is ChatResponseMessage => m.type === "chat_message",
			);
			const audioMessages = messages.filter((m) => m.type === "audio_data");

			expect(chatMessages.length).toBeGreaterThanOrEqual(1);
			expect(audioMessages).toHaveLength(0);
		});
	});
});
