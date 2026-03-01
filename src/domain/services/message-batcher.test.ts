import { describe, expect, it } from "bun:test";

import { createMockChannel, createMockMessage } from "../../application/use-cases/test-helpers.ts";
import { MessageBatcher } from "./message-batcher.ts";

describe("MessageBatcher", () => {
	it("enqueue → flush でメッセージが順序通り返される", () => {
		const batcher = new MessageBatcher();
		const msg1 = createMockMessage("hello", { messageId: "m1" });
		const msg2 = createMockMessage("world", { messageId: "m2" });
		const channel = createMockChannel();

		batcher.enqueue("ch-1", msg1, channel);
		batcher.enqueue("ch-1", msg2, channel);
		const batch = batcher.flush("ch-1");

		expect(batch).toHaveLength(2);
		expect(batch.at(0)?.msg.messageId).toBe("m1");
		expect(batch.at(1)?.msg.messageId).toBe("m2");
	});

	it("flush 後はキューが空になる", () => {
		const batcher = new MessageBatcher();
		batcher.enqueue("ch-1", createMockMessage("hi"), createMockChannel());
		batcher.flush("ch-1");

		expect(batcher.hasPending("ch-1")).toBe(false);
		expect(batcher.flush("ch-1")).toHaveLength(0);
	});

	it("チャンネルごとに独立して管理される", () => {
		const batcher = new MessageBatcher();
		batcher.enqueue("ch-1", createMockMessage("a"), createMockChannel());
		batcher.enqueue("ch-2", createMockMessage("b"), createMockChannel());

		expect(batcher.flush("ch-1")).toHaveLength(1);
		expect(batcher.hasPending("ch-2")).toBe(true);
	});

	it("存在しない channelId の flush は空配列を返す", () => {
		const batcher = new MessageBatcher();
		expect(batcher.flush("nonexistent")).toHaveLength(0);
	});

	it("hasPending は enqueue 前は false", () => {
		const batcher = new MessageBatcher();
		expect(batcher.hasPending("ch-1")).toBe(false);
	});
});
