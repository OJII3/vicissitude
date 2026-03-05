import { describe, expect, it } from "bun:test";

import { inferTrigger } from "./instrumented-ai-agent.ts";

describe("inferTrigger", () => {
	it('should return "heartbeat" for system:heartbeat: prefix', () => {
		expect(inferTrigger("system:heartbeat:_autonomous")).toBe("heartbeat");
		expect(inferTrigger("system:heartbeat:reminder-1")).toBe("heartbeat");
	});

	it('should return "home" for :_channel suffix', () => {
		expect(inferTrigger("discord:ch-123:_channel")).toBe("home");
		expect(inferTrigger("guild:456:_channel")).toBe("home");
	});

	it('should return "mention" for other patterns', () => {
		expect(inferTrigger("discord:ch-123:user-456")).toBe("mention");
		expect(inferTrigger("guild:789:thread-abc")).toBe("mention");
	});
});
