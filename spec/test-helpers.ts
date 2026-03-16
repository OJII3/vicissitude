import { mock } from "bun:test";

import type { Logger } from "../src/core/types.ts";

export function createMockLogger(): Logger {
	return {
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
	};
}
