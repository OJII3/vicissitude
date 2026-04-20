import { describe, expect, it } from "bun:test";

import { generateCorrelationId } from "@vicissitude/observability/correlation";

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateCorrelationId", () => {
	it("文字列を返す", () => {
		const id = generateCorrelationId();
		expect(typeof id).toBe("string");
	});

	it("UUID v7 形式の文字列を返す", () => {
		const id = generateCorrelationId();
		expect(id).toMatch(UUID_V7_REGEX);
	});

	it("毎回異なる値を返す", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
		expect(ids.size).toBe(100);
	});
});
