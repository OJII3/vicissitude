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
