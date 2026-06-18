import { describe, expect, test } from "bun:test";

import { MessageBuffer, mergeMetricLabel } from "./runner-message-buffer.ts";

describe("mergeMetricLabel", () => {
	test("空配列は fallback を返す", () => {
		expect(mergeMetricLabel([undefined, undefined], "fb")).toBe("fb");
	});
	test("1種類なら その値を返す", () => {
		expect(mergeMetricLabel(["a", undefined, "a"], "fb")).toBe("a");
	});
	test("複数種類なら mixed を返す", () => {
		expect(mergeMetricLabel(["a", "b"], "fb")).toBe("mixed");
	});
});

describe("MessageBuffer", () => {
	test("enqueue と size と drain の基本動作", () => {
		const buf = new MessageBuffer();
		buf.enqueue({ text: "hello", trigger: "user", scopeId: "s1" }, false);
		buf.enqueue({ text: "world", trigger: "user", scopeId: "s1" }, false);
		expect(buf.size).toBe(2);
		const drained = buf.drain("none");
		expect(drained.text).toBe("hello\n---\nworld");
		expect(drained.trigger).toBe("user");
		expect(drained.scopeId).toBe("s1");
		expect(buf.size).toBe(0);
	});

	test("drain は trigger/scopeId が混在すると mixed になる", () => {
		const buf = new MessageBuffer();
		buf.enqueue({ text: "a", trigger: "user", scopeId: "s1" }, false);
		buf.enqueue({ text: "b", trigger: "internal", scopeId: "s2" }, false);
		const drained = buf.drain("none");
		expect(drained.trigger).toBe("mixed");
		expect(drained.scopeId).toBe("mixed");
	});

	test("hasBotPending は bot 投入で立ち drain でリセットされる", () => {
		const buf = new MessageBuffer();
		buf.enqueue({ text: "x", trigger: "bot" }, true);
		expect(buf.hasBotPending).toBe(true);
		buf.drain("none");
		expect(buf.hasBotPending).toBe(false);
	});

	test("setLastPrompt / hasLastPrompt / drainForRetry がマージする", () => {
		const buf = new MessageBuffer();
		buf.setLastPrompt("orig", [], "user", "s1");
		expect(buf.hasLastPrompt).toBe(true);
		buf.enqueue({ text: "follow", trigger: "user", scopeId: "s1" }, false);
		const drained = buf.drainForRetry("none");
		expect(drained.text).toBe("orig\n---\nfollow");
	});

	test("新着が無ければ drainForRetry は lastText のみを返す", () => {
		const buf = new MessageBuffer();
		buf.setLastPrompt("orig", [], "user", "s1");
		const drained = buf.drainForRetry("none");
		expect(drained.text).toBe("orig");
	});

	test("requeueLastPrompt は先頭へ戻し、clearLastPrompt 後は何もしない", () => {
		const buf = new MessageBuffer();
		buf.setLastPrompt("orig", [], "user", "s1");
		buf.requeueLastPrompt();
		expect(buf.size).toBe(1);
		buf.clearLastPrompt();
		expect(buf.hasLastPrompt).toBe(false);
		buf.requeueLastPrompt();
		expect(buf.size).toBe(1);
	});
});
