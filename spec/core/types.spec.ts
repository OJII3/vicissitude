import { describe, expect, it } from "bun:test";

import { createDefaultHeartbeatConfig } from "@vicissitude/scheduling/heartbeat-helpers";

describe("createDefaultHeartbeatConfig", () => {
	it("has expected default values", () => {
		const config = createDefaultHeartbeatConfig();
		expect(config.baseIntervalMinutes).toBe(1);
		expect(config.reminders).toHaveLength(3);

		const first = config.reminders[0];
		const second = config.reminders[1];
		const third = config.reminders[2];
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(third).toBeDefined();
		expect(first?.id).toBe("home-check");
		expect(second?.id).toBe("memory-update");
		expect(third?.id).toBe("mc-check");
		expect(third?.enabled).toBe(false);
	});

	it("returns independent instances", () => {
		const a = createDefaultHeartbeatConfig();
		const b = createDefaultHeartbeatConfig();
		const aFirst = a.reminders[0];
		const bFirst = b.reminders[0];
		expect(aFirst).toBeDefined();
		expect(bFirst).toBeDefined();
		if (aFirst) aFirst.enabled = false;
		expect(bFirst?.enabled).toBe(true);
	});
});
