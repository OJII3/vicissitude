/* oxlint-disable require-await, no-constructor-return, typescript/no-extraneous-class -- テスト用モック */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { Logger } from "@vicissitude/shared/types";
import { Events } from "discord.js";

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

function createMockGuild(options?: { meIsNull?: boolean }) {
	const setNickname = mock(async (_nickname: string | null) => {});
	const guild = {
		members: {
			me: options?.meIsNull ? null : { setNickname },
		},
	};
	return { guild, setNickname };
}

function createMockClient(mockGuild?: ReturnType<typeof createMockGuild>["guild"]) {
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
		guilds: {
			fetch: mock(async (_guildId: string) => mockGuild ?? null),
		},
	};
	return mockClient;
}

let currentMockClient: ReturnType<typeof createMockClient> | null = null;
let currentMockGuild: ReturnType<typeof createMockGuild> | null = null;

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

describe("DiscordGateway — ニックネーム設定 API 契約", () => {
	let gateway: DiscordGateway;

	beforeEach(() => {
		currentMockGuild = createMockGuild();
		currentMockClient = createMockClient(currentMockGuild.guild);
		gateway = new DiscordGateway("fake-token", createSilentLogger());
	});

	afterEach(() => {
		gateway.stop();
		currentMockClient = null;
		currentMockGuild = null;
	});

	describe("client 未起動時（getClient() が null）", () => {
		it("setGuildNickname は no-op（例外を投げない）", async () => {
			await gateway.setGuildNickname("guild-1", "ふあ @happy");
		});
	});

	describe("client 起動後", () => {
		beforeEach(async () => {
			await gateway.start();
		});

		it("setGuildNickname が guild.members.me.setNickname を呼ぶ", async () => {
			await gateway.setGuildNickname("guild-1", "ふあ @happy");

			expect(currentMockClient?.guilds.fetch).toHaveBeenCalledWith("guild-1");
			expect(currentMockGuild?.setNickname).toHaveBeenCalledWith("ふあ @happy");
		});

		it("nickname が null の場合も setNickname(null) を呼ぶ", async () => {
			await gateway.setGuildNickname("guild-1", null);

			expect(currentMockGuild?.setNickname).toHaveBeenCalledWith(null);
		});

		it("guild.members.me が null の場合は何もしない（例外を投げない）", async () => {
			const { guild } = createMockGuild({ meIsNull: true });
			currentMockClient = createMockClient(guild);
			gateway = new DiscordGateway("fake-token", createSilentLogger());
			await gateway.start();

			await gateway.setGuildNickname("guild-1", "ふあ");
		});
	});
});
