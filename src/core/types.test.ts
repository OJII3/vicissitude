import { describe, expect, it } from "bun:test";

import {
	DEFAULT_HEARTBEAT_CONFIG,
	channelId,
	createChannelSessionKey,
	createSessionKey,
	guildId,
} from "./types.ts";

describe("Branded types", () => {
	describe("guildId", () => {
		it("creates a GuildId from a non-empty string", () => {
			const id = guildId("12345");
			expect(id as string).toBe("12345");
		});

		it("throws on empty string", () => {
			expect(() => guildId("")).toThrow("GuildId must be a non-empty string");
		});
	});

	describe("channelId", () => {
		it("creates a ChannelId from a non-empty string", () => {
			const id = channelId("67890");
			expect(id as string).toBe("67890");
		});

		it("throws on empty string", () => {
			expect(() => channelId("")).toThrow("ChannelId must be a non-empty string");
		});
	});

	describe("createSessionKey", () => {
		it("creates a session key from platform, channelId, userId", () => {
			const key = createSessionKey("discord", "ch1", "user1");
			expect(key as string).toBe("discord:ch1:user1");
		});
	});

	describe("createChannelSessionKey", () => {
		it("creates a channel session key with _channel suffix", () => {
			const key = createChannelSessionKey("discord", "ch1");
			expect(key as string).toBe("discord:ch1:_channel");
		});
	});
});

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
