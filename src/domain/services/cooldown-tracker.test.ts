import { describe, expect, it } from "bun:test";

import { CooldownTracker } from "./cooldown-tracker.ts";

describe("CooldownTracker", () => {
	it("記録前はクールダウン中ではない", () => {
		const tracker = new CooldownTracker();
		expect(tracker.isOnCooldown("ch-1", 60)).toBe(false);
	});

	it("記録直後はクールダウン中", () => {
		const tracker = new CooldownTracker();
		const now = 1000000;
		tracker.record("ch-1", now);
		expect(tracker.isOnCooldown("ch-1", 60, now + 1000)).toBe(true);
	});

	it("クールダウン時間経過後は解除される", () => {
		const tracker = new CooldownTracker();
		const now = 1000000;
		tracker.record("ch-1", now);
		expect(tracker.isOnCooldown("ch-1", 60, now + 61000)).toBe(false);
	});

	it("チャンネルごとに独立して管理される", () => {
		const tracker = new CooldownTracker();
		const now = 1000000;
		tracker.record("ch-1", now);
		expect(tracker.isOnCooldown("ch-1", 60, now + 1000)).toBe(true);
		expect(tracker.isOnCooldown("ch-2", 60, now + 1000)).toBe(false);
	});

	it("クールダウン秒数ちょうどでは解除される", () => {
		const tracker = new CooldownTracker();
		const now = 1000000;
		tracker.record("ch-1", now);
		expect(tracker.isOnCooldown("ch-1", 60, now + 60000)).toBe(false);
	});
});

describe("CooldownTracker.getRemainingMs", () => {
	it("記録前は 0 を返す", () => {
		const tracker = new CooldownTracker();
		expect(tracker.getRemainingMs("ch-1", 60)).toBe(0);
	});

	it("クールダウン中は残り時間を返す", () => {
		const tracker = new CooldownTracker();
		const now = 1000000;
		tracker.record("ch-1", now);
		expect(tracker.getRemainingMs("ch-1", 60, now + 10000)).toBe(50000);
	});

	it("クールダウン経過後は 0 を返す", () => {
		const tracker = new CooldownTracker();
		const now = 1000000;
		tracker.record("ch-1", now);
		expect(tracker.getRemainingMs("ch-1", 60, now + 61000)).toBe(0);
	});

	it("クールダウン秒数ちょうどでは 0 を返す", () => {
		const tracker = new CooldownTracker();
		const now = 1000000;
		tracker.record("ch-1", now);
		expect(tracker.getRemainingMs("ch-1", 60, now + 60000)).toBe(0);
	});
});
