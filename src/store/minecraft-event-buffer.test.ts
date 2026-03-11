import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { BufferedEvent } from "../core/types.ts";
import { MinecraftEventBuffer } from "./minecraft-event-buffer.ts";

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

	test("wake signal file が更新されると早期 resolve する", async () => {
		const tempDir = join(process.cwd(), "tmp");
		mkdirSync(tempDir, { recursive: true });
		const signalPath = join(tempDir, `minecraft-wake-${String(Date.now())}.signal`);
		writeFileSync(signalPath, "initial", "utf8");

		const buffer = new MinecraftEventBuffer(10_000, signalPath, 20);
		const controller = new AbortController();

		setTimeout(() => writeFileSync(signalPath, "wakeup", "utf8"), 50);

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(500);
	});

	test("待機開始前に更新済みの wake signal を即時消化する", async () => {
		const tempDir = join(process.cwd(), "tmp");
		mkdirSync(tempDir, { recursive: true });
		const signalPath = join(tempDir, `minecraft-wake-pending-${String(Date.now())}.signal`);
		writeFileSync(signalPath, "pending", "utf8");

		const buffer = new MinecraftEventBuffer(10_000, signalPath, 20);
		const controller = new AbortController();

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(50);
	});
});
