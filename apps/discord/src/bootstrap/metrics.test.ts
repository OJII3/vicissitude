import { describe, expect, test } from "bun:test";

import { createMockLogger } from "@vicissitude/shared/test-helpers";

import { createMetrics } from "./metrics.ts";

describe("createMetrics", () => {
	test("collector と server を返す", () => {
		const logger = createMockLogger();
		const { collector, server } = createMetrics(logger, 0);

		expect(collector).toBeDefined();
		expect(server).toBeDefined();
	});
});
