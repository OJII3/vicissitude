import { describe, expect, it } from "bun:test";

import { DEFAULT_HEARTBEAT_CONFIG } from "./types.ts";

describe("DEFAULT_HEARTBEAT_CONFIG", () => {
	it("has expected default values", () => {
		expect(DEFAULT_HEARTBEAT_CONFIG.baseIntervalMinutes).toBe(1);
		expect(DEFAULT_HEARTBEAT_CONFIG.reminders).toHaveLength(2);

		const first = DEFAULT_HEARTBEAT_CONFIG.reminders[0];
		const second = DEFAULT_HEARTBEAT_CONFIG.reminders[1];
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first?.id).toBe("home-check");
		expect(second?.id).toBe("memory-update");
	});
});
