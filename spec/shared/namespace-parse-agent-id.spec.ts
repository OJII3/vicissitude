import { describe, expect, test } from "bun:test";

import { parseAgentId } from "@vicissitude/shared/namespace";

describe("parseAgentId", () => {
	describe("strict mode (default)", () => {
		test("discord polling agentId をパースできる", () => {
			expect(parseAgentId("discord:111")).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:guild:111",
			});
		});

		test("discord heartbeat agentId をパースできる", () => {
			expect(parseAgentId("discord:heartbeat:111")).toEqual({
				platform: "discord",
				role: "heartbeat",
				scopeId: "discord:guild:111",
			});
		});

		test("discord DM agentId をパースできる", () => {
			expect(parseAgentId("discord:dm:222")).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:dm:222",
			});
		});

		test("guildId が数字でない場合は null", () => {
			expect(parseAgentId("discord:guild-1")).toBeNull();
		});

		test("userId が数字でない場合は null", () => {
			expect(parseAgentId("discord:dm:user-x")).toBeNull();
		});

		test("web agentId はスコープ形式なら通る", () => {
			expect(parseAgentId("web:local")).toEqual({
				platform: "web",
				scopeId: "web:local",
			});
		});

		test("不正な web agentId は null", () => {
			expect(parseAgentId("web:")).toBeNull();
		});

		test("internal agentId はパースできる", () => {
			expect(parseAgentId("internal:anything")).toEqual({ platform: "internal" });
		});

		test("null/undefined/空文字は null", () => {
			expect(parseAgentId(null)).toBeNull();
			expect(parseAgentId(undefined)).toBeNull();
			expect(parseAgentId("")).toBeNull();
		});
	});

	describe("loose mode (strict: false)", () => {
		test("数字でない guildId もそのまま scopeId に詰める", () => {
			expect(parseAgentId("discord:guild-1", { strict: false })).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:guild:guild-1",
			});
		});

		test("heartbeat の緩い形式も scopeId に詰める", () => {
			expect(parseAgentId("discord:heartbeat:guild-1", { strict: false })).toEqual({
				platform: "discord",
				role: "heartbeat",
				scopeId: "discord:guild:guild-1",
			});
		});

		test("DM ユーザー ID も数字でなくても scopeId に詰める", () => {
			expect(parseAgentId("discord:dm:user-x", { strict: false })).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:dm:user-x",
			});
		});
	});
});
