import { describe, expect, test } from "bun:test";

import { createPortLayout } from "../../apps/discord/src/port-allocator.ts";

describe("createPortLayout", () => {
	const basePort = 4096;
	const conversationAgentCount = 5;
	const heartbeatAgentCount = 3;
	const ports = createPortLayout(basePort, conversationAgentCount, heartbeatAgentCount);

	test("conversation(i) returns basePort + i", () => {
		expect(ports.conversation(0)).toBe(4096);
		expect(ports.conversation(1)).toBe(4097);
		expect(ports.conversation(4)).toBe(4100);
	});

	test("minecraft() returns basePort + conversationAgentCount", () => {
		expect(ports.minecraft()).toBe(4101);
	});

	test("heartbeat(i) returns after conversation agents and minecraft", () => {
		expect(ports.heartbeat(0)).toBe(4102);
		expect(ports.heartbeat(1)).toBe(4103);
		expect(ports.heartbeat(2)).toBe(4104);
	});

	test("heartbeatOffset returns conversationAgentCount + 1", () => {
		expect(ports.heartbeatOffset).toBe(6);
	});

	test("memory() returns basePort - 2", () => {
		expect(ports.memory()).toBe(4094);
	});

	test("webAgent() returns the first port after heartbeat agents", () => {
		expect(ports.webAgent()).toBe(4105);
	});

	test("port ranges do not overlap", () => {
		const allPorts = [
			...Array.from({ length: conversationAgentCount }, (_, i) => ports.conversation(i)),
			ports.minecraft(),
			...Array.from({ length: heartbeatAgentCount }, (_, i) => ports.heartbeat(i)),
			ports.webAgent(),
			ports.memory(),
		];
		const unique = new Set(allPorts);
		expect(unique.size).toBe(allPorts.length);
	});
});
