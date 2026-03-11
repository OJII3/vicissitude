import { describe, expect, test } from "bun:test";

import { shouldWakeMinecraftBrain } from "./brain-wake.ts";

describe("shouldWakeMinecraftBrain", () => {
	test("health medium は wake する", () => {
		expect(shouldWakeMinecraftBrain("health", "medium", "Health: 20, Food: 0")).toBe(true);
	});

	test("低重要度 chat は wake しない", () => {
		expect(shouldWakeMinecraftBrain("chat", "low", "<a> hi")).toBe(false);
	});
});
