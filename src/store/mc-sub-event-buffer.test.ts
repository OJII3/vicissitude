import { describe, expect, test } from "bun:test";

import type { BufferedEvent } from "../core/types.ts";
import { MinecraftEventBuffer } from "./mc-sub-event-buffer.ts";

describe("MinecraftEventBuffer", () => {
	test("append is a no-op (does not throw)", () => {
		const buffer = new MinecraftEventBuffer(1000);
		const event: BufferedEvent = {
			ts: new Date().toISOString(),
			channelId: "test",
			authorId: "test",
			authorName: "test",
			messageId: "test",
			content: "test",
			isBot: false,
			isMentioned: false,
			isThread: false,
		};
		expect(() => buffer.append(event)).not.toThrow();
	});

	test("waitForEvents resolves after interval", async () => {
		const buffer = new MinecraftEventBuffer(50);
		const controller = new AbortController();

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(40);
	});

	test("waitForEvents resolves immediately when already aborted", async () => {
		const buffer = new MinecraftEventBuffer(10_000);
		const controller = new AbortController();
		controller.abort();

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50);
	});

	test("waitForEvents resolves early when aborted during wait", async () => {
		const buffer = new MinecraftEventBuffer(10_000);
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 50);

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(200);
	});

	test("abort listener is cleaned up after timer fires", async () => {
		const buffer = new MinecraftEventBuffer(10);
		const controller = new AbortController();

		await buffer.waitForEvents(controller.signal);
		await buffer.waitForEvents(controller.signal);
		await buffer.waitForEvents(controller.signal);

		// abort しても問題ない（リスナーがクリーンアップされている）
		controller.abort();
	});
});
