/* oxlint-disable require-await, no-constructor-return, typescript/no-extraneous-class -- テスト用モック */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { Logger } from "@vicissitude/shared/types";
import { ActivityType, Events } from "discord.js";

import { DiscordGateway } from "../../apps/discord/src/gateway/discord";

// ─── Helpers ─────────────────────────────────────────────────────

function createSilentLogger(): Logger {
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		error: () => {},
		warn: () => {},
		child: () => logger,
	};
	return logger;
}

function createMockClient() {
	const user = {
		id: "bot-user-id",
		tag: "TestBot#0001",
		setActivity: mock((_name?: string, _opts?: unknown) => {}),
	};
	const mockClient = {
		user,
		login: mock(async () => {}),
		destroy: mock(() => {}),
		once: mock((event: string, cb: (...args: unknown[]) => void) => {
			if (event === (Events.ClientReady as string)) cb(mockClient);
		}),
		on: mock(() => {}),
		channels: { fetch: mock(() => Promise.resolve(null)) },
	};
	return mockClient;
}

let currentMockClient: ReturnType<typeof createMockClient> | null = null;

void mock.module("discord.js", () => {
	// oxlint-disable-next-line typescript/no-require-imports
	const actual = require("discord.js");
	// oxlint-disable-next-line typescript/no-unsafe-return -- mock.module のコールバックは require() の any を spread するため
	return {
		...actual,
		// oxlint-disable-next-line no-constructor-return
		Client: class MockedClient {
			constructor() {
				currentMockClient ??= createMockClient();
				return currentMockClient as unknown as MockedClient;
			}
		},
	};
});

// ─── Tests ───────────────────────────────────────────────────────

describe("DiscordGateway — プレゼンス表示 API 契約", () => {
	let gateway: DiscordGateway;

	beforeEach(() => {
		currentMockClient = createMockClient();
		gateway = new DiscordGateway("fake-token", createSilentLogger());
	});

	afterEach(() => {
		gateway.stop();
		currentMockClient = null;
	});

	describe("client 未起動時（getClient() が null）", () => {
		it("clearActivity は no-op（例外を投げない）", () => {
			expect(() => gateway.clearActivity()).not.toThrow();
		});
	});

	describe("client 起動後", () => {
		beforeEach(async () => {
			await gateway.start();
		});

		it("clearActivity が client.user.setActivity を引数なし/null で呼ぶ（プレゼンスクリア）", () => {
			gateway.clearActivity();

			const setActivity = currentMockClient?.user.setActivity;
			expect(setActivity).toHaveBeenCalled();
		});

		it("setWatchingActivity は Watching activity として設定する", () => {
			gateway.setWatchingActivity("12%");

			const setActivity = currentMockClient?.user.setActivity;
			expect(setActivity).toHaveBeenCalledWith("12%", { type: ActivityType.Watching });
		});
	});
});
