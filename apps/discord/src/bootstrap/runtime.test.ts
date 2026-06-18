/* oxlint-disable max-lines, max-lines-per-function -- bootstrap の DI 結合テストはケース数に応じて長くなるため許容 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { createMockLogger } from "@vicissitude/shared/test-helpers";
import type { DueReminder } from "@vicissitude/shared/types";

import type { AppConfig } from "../config.ts";
import { buildEmailCheckPreFilter, resolveBootstrapRoot } from "./runtime.ts";

function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
	return {
		discordToken: "test-token",
		webPort: 4000,
		gatewayPort: 4001,
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 4096,
			sessionMaxAgeHours: 48,
			temperature: 1.0,
		},
		heartbeatOpencode: {
			providerId: "test-heartbeat-provider",
			modelId: "test-heartbeat-model",
			temperature: 0.3,
		},
		memory: {
			providerId: "test-provider",
			modelId: "test-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "test-embedding",
		},
		mcBrain: {
			providerId: "test-provider",
			modelId: "test-model",
			temperature: 0.7,
		},
		dataDir: "/tmp/vicissitude-bootstrap-test",
		contextDir: "/tmp/test-context",
		...overrides,
	};
}

describe("resolveBootstrapRoot", () => {
	test("APP_ROOT があればそれを優先する", () => {
		const root = resolveBootstrapRoot(createTestConfig(), {
			APP_ROOT: "/tmp/from-env",
		} as NodeJS.ProcessEnv);

		expect(root).toBe("/tmp/from-env");
	});

	test("APP_ROOT がなければ contextDir の親を使う", () => {
		const root = resolveBootstrapRoot(
			createTestConfig({
				contextDir: "/tmp/vicissitude-root/context",
			}),
			{} as NodeJS.ProcessEnv,
		);

		expect(root).toBe("/tmp/vicissitude-root");
	});
});

function emailCheckDueReminder(): DueReminder {
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

function otherDueReminder(id: string): DueReminder {
	return {
		reminder: {
			id,
			description: id,
			schedule: { type: "interval", minutes: 60 },
			lastExecutedAt: null,
			enabled: true,
		},
		overdueMinutes: 0,
	};
}

function newMailFetchPayload() {
	return {
		hasNewMail: true,
		count: 1,
		emails: [
			{ subject: "件名", from: "a@example.com", date: "2026-06-10T09:00:00Z", bodyExcerpt: "本文" },
		],
	};
}

describe("buildEmailCheckPreFilter 内部分岐", () => {
	const EMAIL_CONFIG = { endpoint: "https://example.com/exec", token: "tok" };
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const emailCheckDue = emailCheckDueReminder;
	const otherDue = otherDueReminder;
	const newMailPayload = newMailFetchPayload;

	function mockFetchJson(payload: unknown): void {
		globalThis.fetch = mock(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(payload),
				text: () => Promise.resolve(""),
			} as Response),
		) as unknown as typeof globalThis.fetch;
	}

	test("dueReminders が空なら fetch せず空 reminders を返す", async () => {
		const fetchSpy = mock(() => Promise.reject(new Error("should not fetch")));
		globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([]);

		expect(result.reminders).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("新着あり: 元の DueReminder オブジェクトを破壊せず複製に context を注入する", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const original = emailCheckDue();
		const result = await preFilter([original]);

		expect(original.context).toBeUndefined();
		const enriched = result.reminders.find((r) => r.reminder.id === "email-check");
		expect(enriched).not.toBe(original);
		expect(enriched?.context).toBeDefined();
	});

	test("新着あり: reminders は [...other, ...enriched] の順で並ぶ", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), otherDue("home-check")]);

		expect(result.reminders.map((r) => r.reminder.id)).toEqual(["home-check", "email-check"]);
	});

	test("新着あり: 複数の email-check reminder すべてに同一 context を注入する", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), emailCheckDue()]);

		const enriched = result.reminders.filter((r) => r.reminder.id === "email-check");
		expect(enriched).toHaveLength(2);
		expect(enriched[0]?.context).toBe(enriched[1]?.context);
		expect(enriched[0]?.context).toContain("<email_context>");
	});

	test("新着あり: 注入される context は本文抜粋を含む", async () => {
		mockFetchJson(newMailPayload());
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue()]);

		const enriched = result.reminders.find((r) => r.reminder.id === "email-check");
		expect(enriched?.context).toContain("件名");
		expect(enriched?.context).toContain("本文");
	});

	test("新着なし: 新着 0 件のときは markExecutedIds=['email-check'] で除外する", async () => {
		mockFetchJson({ hasNewMail: false, count: 0, emails: [] });
		const preFilter = buildEmailCheckPreFilter(createMockLogger(), EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue(), otherDue("home-check")]);

		expect(result.reminders.map((r) => r.reminder.id)).toEqual(["home-check"]);
		expect(result.markExecutedIds).toEqual(["email-check"]);
	});

	test("fetch 失敗時は logger.error を呼びつつ markExecutedIds で除外する", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("network down")),
		) as unknown as typeof globalThis.fetch;
		const logger = createMockLogger();
		const preFilter = buildEmailCheckPreFilter(logger, EMAIL_CONFIG);
		if (!preFilter) throw new Error("preFilter should be defined");

		const result = await preFilter([emailCheckDue()]);

		expect(logger.error).toHaveBeenCalled();
		expect(result.reminders).toEqual([]);
		expect(result.markExecutedIds).toEqual(["email-check"]);
	});
});
