import { afterEach, describe, expect, it, mock } from "bun:test";

import type { DueReminder } from "@vicissitude/shared/types";

import { buildEmailCheckPreFilter } from "../../apps/discord/src/bootstrap.ts";
import type { AppConfig } from "../../apps/discord/src/config.ts";
import { createMockLogger } from "../test-helpers.ts";

function emailCheckDue(): DueReminder {
	return {
		reminder: {
			id: "email-check",
			description: "メール確認",
			schedule: { type: "interval", minutes: 5 },
			lastExecutedAt: null,
			enabled: true,
		},
		overdueMinutes: 0,
	};
}

function homeCheckDue(): DueReminder {
	return {
		reminder: {
			id: "home-check",
			description: "様子見",
			schedule: { type: "interval", minutes: 60 },
			lastExecutedAt: null,
			enabled: true,
		},
		overdueMinutes: 0,
	};
}

describe("buildEmailCheckPreFilter", () => {
	const EMAIL_CONFIG = { endpoint: "https://script.google.com/exec", token: "tok" };

	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function mockFetchJson(payload: unknown, ok = true): void {
		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok,
				status: ok ? 200 : 500,
				json: () => Promise.resolve(payload),
				text: () => Promise.resolve(""),
			} as Response),
		) as unknown as typeof globalThis.fetch;
	}

	it("emailConfig が未設定なら preFilter を生成しない", () => {
		const noConfig: AppConfig["emailCheck"] = undefined;
		expect(buildEmailCheckPreFilter(createMockLogger(), noConfig)).toBeUndefined();
	});

	it("email-check が due でなければ fetch せず dueReminders をそのまま返す", async () => {
		const fetchSpy = mock(() => Promise.reject(new Error("should not fetch")));
		globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const due = [homeCheckDue()];
		const result = await preFilter(due);

		expect(result.reminders).toEqual(due);
		expect(result.markExecutedIds).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("新着メールがあれば email-check に context を注入して reminders に含める", async () => {
		mockFetchJson({
			hasNewMail: true,
			count: 1,
			emails: [
				{
					subject: "件名",
					from: "a@example.com",
					date: "2026-06-10T09:00:00Z",
					bodyExcerpt: "本文",
				},
			],
		});
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), homeCheckDue()]);

		const enriched = result.reminders.find((r) => r.reminder.id === "email-check");
		expect(enriched?.context).toContain("<email_context>");
		expect(result.reminders.some((r) => r.reminder.id === "home-check")).toBe(true);
		expect(result.markExecutedIds).toBeUndefined();
	});

	it("新着メールが無ければ email-check を除外し markExecutedIds に含める", async () => {
		mockFetchJson({ hasNewMail: false, count: 0, emails: [] });
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), homeCheckDue()]);

		expect(result.reminders.some((r) => r.reminder.id === "email-check")).toBe(false);
		expect(result.reminders.some((r) => r.reminder.id === "home-check")).toBe(true);
		expect(result.markExecutedIds).toEqual(["email-check"]);
	});

	it("fetch 失敗時も email-check を markExecutedIds に含めて毎 tick ポーリングを防ぐ", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("network down")),
		) as unknown as typeof globalThis.fetch;
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), homeCheckDue()]);

		expect(result.reminders.some((r) => r.reminder.id === "email-check")).toBe(false);
		expect(result.markExecutedIds).toEqual(["email-check"]);
	});
});
