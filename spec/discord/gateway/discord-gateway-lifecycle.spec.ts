/* oxlint-disable require-await, no-constructor-return, typescript/no-floating-promises -- テスト用モック */
import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { Logger } from "@vicissitude/shared/types";
import { Events } from "discord.js";

import { DiscordGateway } from "../../../apps/discord/src/gateway/discord";

function createMockClient() {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	const mockClient = {
		user: { id: "bot-user-id", tag: "TestBot#0001" },
		login: mock(async () => {}),
		destroy: mock(() => {}),
		once: mock((_event: string, _cb: (...args: unknown[]) => void) => {}),
		on: mock((event: string, cb: (...args: unknown[]) => void) => {
			listeners.set(event, [...(listeners.get(event) ?? []), cb]);
		}),
		channels: { fetch: mock(async () => null) },
	};
	return {
		mockClient,
		emit(event: string, ...args: unknown[]) {
			for (const listener of listeners.get(event) ?? []) listener(...args);
		},
	};
}

function createSpyLogger() {
	const calls: { level: string; args: unknown[] }[] = [];
	const logger: Logger = {
		debug: (...args) => calls.push({ level: "debug", args }),
		info: (...args) => calls.push({ level: "info", args }),
		warn: (...args) => calls.push({ level: "warn", args }),
		error: (...args) => calls.push({ level: "error", args }),
		child: () => logger,
	};
	return { logger, calls };
}

let currentMockClient: ReturnType<typeof createMockClient>;

mock.module("discord.js", () => {
	// oxlint-disable-next-line typescript/no-require-imports
	const actual = require("discord.js");
	// oxlint-disable-next-line typescript/no-unsafe-return -- mock.module のコールバックは require() の any を spread するため
	return {
		...actual,
		// oxlint-disable-next-line no-constructor-return, typescript/no-extraneous-class
		Client: class MockedClient {
			constructor() {
				return currentMockClient.mockClient as unknown as MockedClient;
			}
		},
	};
});

describe("DiscordGateway Gateway lifecycle", () => {
	beforeEach(() => {
		currentMockClient = createMockClient();
	});

	it("切断・エラー・再接続・resume を shard ID とともに記録する", async () => {
		const { logger, calls } = createSpyLogger();
		const gateway = new DiscordGateway("fake-token", logger);
		await gateway.start();

		currentMockClient.emit(Events.ShardDisconnect, { code: 1006, reason: "network" }, 2);
		currentMockClient.emit(Events.ShardError, new Error("socket failed"), 2);
		currentMockClient.emit(Events.ShardReconnecting, 2);
		currentMockClient.emit(Events.ShardResume, 2, 7);

		const messages = calls.map(({ level, args }) => `${level}:${String(args[0])}`);
		expect(
			messages.some((message) => message.includes("warn:[discord] shard 2 disconnected")),
		).toBe(true);
		expect(messages.some((message) => message.includes("error:[discord] shard 2 error"))).toBe(
			true,
		);
		expect(
			messages.some((message) => message.includes("warn:[discord] shard 2 reconnecting")),
		).toBe(true);
		expect(messages.some((message) => message.includes("info:[discord] shard 2 resumed"))).toBe(
			true,
		);
	});

	it("resume 時に登録済み復旧ハンドラを呼ぶ", async () => {
		const { logger } = createSpyLogger();
		const gateway = new DiscordGateway("fake-token", logger);
		const onResume = mock(() => {});
		gateway.onResume(onResume);
		await gateway.start();

		currentMockClient.emit(Events.ShardResume, 3, 12);

		expect(onResume).toHaveBeenCalledTimes(1);
	});

	it("同一 shard の2回目の ready 時にも復旧ハンドラを呼ぶ", async () => {
		const { logger } = createSpyLogger();
		const gateway = new DiscordGateway("fake-token", logger);
		const onResume = mock(() => {});
		gateway.onResume(onResume);
		await gateway.start();

		currentMockClient.emit(Events.ShardReady, 1, new Set());
		expect(onResume).not.toHaveBeenCalled();

		currentMockClient.emit(Events.ShardReady, 1, new Set());
		expect(onResume).toHaveBeenCalledTimes(1);
	});
});
