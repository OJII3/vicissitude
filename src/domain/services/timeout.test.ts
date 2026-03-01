import { describe, expect, test } from "bun:test";

import { withTimeout } from "./timeout.ts";

describe("withTimeout", () => {
	test("resolves when promise completes before timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 1000, "timed out");
		expect(result).toBe("ok");
	});

	test("rejects with timeout error when promise takes too long", async () => {
		const slow = new Promise<string>((resolve) => {
			setTimeout(() => resolve("late"), 500);
		});
		await expect(withTimeout(slow, 10, "timed out")).rejects.toThrow("timed out");
	});

	test("propagates original error when promise rejects before timeout", async () => {
		const failing = Promise.reject(new Error("original"));
		await expect(withTimeout(failing, 1000, "timed out")).rejects.toThrow("original");
	});
});
