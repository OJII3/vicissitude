import { describe, expect, it, spyOn } from "bun:test";

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
		it("ハンドラが例外を投げた場合、catch ブロックで捕捉されエラーメッセージが返る", () => {
			const manager = new WsConnectionManager();
			const conn = createMockConnection();
			manager.handleOpen("conn-1", conn);

			manager.onMessage(() => {
				throw new Error("handler error");
			});

			// try ブロックがハンドラ呼び出しも包んでいるため、例外は外に伝播しない
			expect(() => manager.handleMessage("conn-1", JSON.stringify(validChatInput))).not.toThrow();

			// catch ブロックでエラーメッセージが送信される
			expect(conn.sent).toHaveLength(1);
			const errorMsg = JSON.parse(conn.sent[0] as string);
			expect(errorMsg.type).toBe("error");
			expect(errorMsg.code).toBe("INVALID_MESSAGE");
		});

		it("先行ハンドラが例外を投げると、後続ハンドラは呼ばれない", () => {
			const manager = new WsConnectionManager();
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

			expect(secondCalled).toBe(false);
		});
	});
});
