import { describe, expect, test } from "bun:test";

import {
	createDefaultHeartbeatConfig,
	evaluateDueReminders,
} from "@vicissitude/scheduling/heartbeat-helpers";
import type { HeartbeatConfig } from "@vicissitude/shared/types";

describe("createDefaultHeartbeatConfig", () => {
	test("email-check リマインダーをデフォルト無効で含む", () => {
		const config = createDefaultHeartbeatConfig();
		const emailCheck = config.reminders.find((r) => r.id === "email-check");

		expect(emailCheck).toBeDefined();
		expect(emailCheck?.enabled).toBe(false);
	});

	test("email-check は 5 分間隔の interval スケジュール", () => {
		const config = createDefaultHeartbeatConfig();
		const emailCheck = config.reminders.find((r) => r.id === "email-check");

		expect(emailCheck?.schedule).toEqual({ type: "interval", minutes: 5 });
	});
});

describe("evaluateDueReminders", () => {
	test("due reminder は config 内 reminder 参照ではなく immutable DTO として返す", () => {
		const config: HeartbeatConfig = {
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "due",
					description: "due reminder",
					schedule: { type: "interval", minutes: 30 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		};

		const [due] = evaluateDueReminders(config, new Date("2026-03-01T12:00:00Z"));

		expect(due).toBeDefined();
		expect(due?.reminder).toEqual(config.reminders[0]);
		expect(due?.reminder).not.toBe(config.reminders[0]);
		expect(due?.reminder.schedule).not.toBe(config.reminders[0]?.schedule);
		expect(Object.isFrozen(due)).toBe(true);
		expect(Object.isFrozen(due?.reminder)).toBe(true);
		expect(Object.isFrozen(due?.reminder.schedule)).toBe(true);
	});
});
