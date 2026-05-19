import { describe, expect, it } from "bun:test";

import { checkScope, filterRemindersByScope } from "@vicissitude/mcp/tools/schedule";
import type { HeartbeatReminder } from "@vicissitude/shared/types";

// ─── テストデータ ──────────────────────────────────────────────

function makeReminder(id: string, scopeId?: string): HeartbeatReminder {
	return {
		id,
		description: `reminder-${id}`,
		schedule: { type: "interval", minutes: 60 },
		lastExecutedAt: null,
		enabled: true,
		scopeId,
	};
}

const SCOPE_A = "discord:guild:111111111111111111";
const SCOPE_B = "discord:guild:222222222222222222";

// ─── filterRemindersByScope ─────────────────────────────────────

describe("filterRemindersByScope", () => {
	it("指定 scope のリマインダーを返す", () => {
		const reminders = [makeReminder("a1", SCOPE_A), makeReminder("b1", SCOPE_B)];

		const result = filterRemindersByScope(reminders, SCOPE_A);

		expect(result.map((r) => r.id)).toEqual(["a1"]);
	});

	it("グローバルリマインダー（scopeId なし）も含めて返す", () => {
		const reminders = [
			makeReminder("a1", SCOPE_A),
			makeReminder("global1"),
			makeReminder("b1", SCOPE_B),
		];

		const result = filterRemindersByScope(reminders, SCOPE_A);

		expect(result.map((r) => r.id)).toEqual(["a1", "global1"]);
	});

	it("他 scope のリマインダーは返さない", () => {
		const reminders = [makeReminder("b1", SCOPE_B), makeReminder("b2", SCOPE_B)];

		const result = filterRemindersByScope(reminders, SCOPE_A);

		expect(result).toEqual([]);
	});

	it("リマインダーが空なら空配列を返す", () => {
		const result = filterRemindersByScope([], SCOPE_A);

		expect(result).toEqual([]);
	});

	it("グローバルリマインダーのみの場合も正しく返す", () => {
		const reminders = [makeReminder("g1"), makeReminder("g2")];

		const result = filterRemindersByScope(reminders, SCOPE_A);

		expect(result.map((r) => r.id)).toEqual(["g1", "g2"]);
	});
});

// ─── checkScope ─────────────────────────────────────────────────

describe("checkScope", () => {
	it("自 scope のリマインダーなら true を返す", () => {
		const reminder = makeReminder("a1", SCOPE_A);

		expect(checkScope(reminder, SCOPE_A)).toBe(true);
	});

	it("グローバルリマインダーなら true を返す", () => {
		const reminder = makeReminder("g1");

		expect(checkScope(reminder, SCOPE_A)).toBe(true);
	});

	it("他 scope のリマインダーなら false を返す", () => {
		const reminder = makeReminder("b1", SCOPE_B);

		expect(checkScope(reminder, SCOPE_A)).toBe(false);
	});
});
