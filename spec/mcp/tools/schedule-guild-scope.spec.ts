import { describe, expect, it } from "bun:test";

import { checkGuildScope, filterRemindersByGuild } from "@vicissitude/mcp/tools/schedule";
import type { HeartbeatReminder } from "@vicissitude/shared/types";

// ─── テストデータ ──────────────────────────────────────────────

function makeReminder(id: string, guildId?: string): HeartbeatReminder {
	return {
		id,
		description: `reminder-${id}`,
		schedule: { type: "interval", minutes: 60 },
		lastExecutedAt: null,
		enabled: true,
		guildId,
	};
}

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";

// ─── filterRemindersByGuild ─────────────────────────────────────

describe("filterRemindersByGuild", () => {
	it("指定ギルドのリマインダーを返す", () => {
		const reminders = [makeReminder("a1", GUILD_A), makeReminder("b1", GUILD_B)];

		const result = filterRemindersByGuild(reminders, GUILD_A);

		expect(result.map((r) => r.id)).toEqual(["a1"]);
	});

	it("グローバルリマインダー（guildId なし）も含めて返す", () => {
		const reminders = [
			makeReminder("a1", GUILD_A),
			makeReminder("global1"),
			makeReminder("b1", GUILD_B),
		];

		const result = filterRemindersByGuild(reminders, GUILD_A);

		expect(result.map((r) => r.id)).toEqual(["a1", "global1"]);
	});

	it("他ギルドのリマインダーは返さない", () => {
		const reminders = [makeReminder("b1", GUILD_B), makeReminder("b2", GUILD_B)];

		const result = filterRemindersByGuild(reminders, GUILD_A);

		expect(result).toEqual([]);
	});

	it("リマインダーが空なら空配列を返す", () => {
		const result = filterRemindersByGuild([], GUILD_A);

		expect(result).toEqual([]);
	});

	it("グローバルリマインダーのみの場合も正しく返す", () => {
		const reminders = [makeReminder("g1"), makeReminder("g2")];

		const result = filterRemindersByGuild(reminders, GUILD_A);

		expect(result.map((r) => r.id)).toEqual(["g1", "g2"]);
	});
});

// ─── checkGuildScope ────────────────────────────────────────────

describe("checkGuildScope", () => {
	it("自ギルドのリマインダーなら true を返す", () => {
		const reminder = makeReminder("a1", GUILD_A);

		expect(checkGuildScope(reminder, GUILD_A)).toBe(true);
	});

	it("グローバルリマインダーなら true を返す", () => {
		const reminder = makeReminder("g1");

		expect(checkGuildScope(reminder, GUILD_A)).toBe(true);
	});

	it("他ギルドのリマインダーなら false を返す", () => {
		const reminder = makeReminder("b1", GUILD_B);

		expect(checkGuildScope(reminder, GUILD_A)).toBe(false);
	});
});
