import { describe, expect, test } from "bun:test";

import { createPortLayout } from "../../apps/discord/src/port-allocator.ts";

describe("createPortLayout", () => {
	const basePort = 4096;
	const guildCount = 3;
	const ports = createPortLayout(basePort, guildCount);

	test("guild(i) returns basePort + i", () => {
		expect(ports.guild(0)).toBe(4096);
		expect(ports.guild(1)).toBe(4097);
		expect(ports.guild(2)).toBe(4098);
	});

	test("minecraft() returns basePort + guildCount", () => {
		expect(ports.minecraft()).toBe(4099);
	});

	test("heartbeat(i) returns basePort + guildCount + 1 + i", () => {
		expect(ports.heartbeat(0)).toBe(4100);
		expect(ports.heartbeat(1)).toBe(4101);
		expect(ports.heartbeat(2)).toBe(4102);
	});

	test("memory() returns basePort - 2", () => {
		expect(ports.memory()).toBe(4094);
	});

	test("port ranges do not overlap", () => {
		const allPorts = [
			...Array.from({ length: guildCount }, (_, i) => ports.guild(i)),
			ports.minecraft(),
			...Array.from({ length: guildCount }, (_, i) => ports.heartbeat(i)),
			ports.memory(),
		];
		const unique = new Set(allPorts);
		expect(unique.size).toBe(allPorts.length);
	});
});
