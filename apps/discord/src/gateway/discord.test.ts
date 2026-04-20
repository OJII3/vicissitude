/* oxlint-disable require-await, no-constructor-return, typescript/no-floating-promises -- テスト用モック */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { Events } from "discord.js";

import { DiscordGateway } from "./discord";

// ─── Helpers ─────────────────────────────────────────────────────

function createMockClient() {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

	const mockClient = {
		user: { id: "bot-user-id", tag: "TestBot#0001" },
		login: mock(async () => {}),
		destroy: mock(() => {}),
		once: mock((event: string, cb: (...args: unknown[]) => void) => {
			if (event === (Events.ClientReady as string)) {
				cb(mockClient);
			}
		}),
		on: mock((event: string, cb: (...args: unknown[]) => void) => {
			const existing = listeners.get(event) ?? [];
			existing.push(cb);
			listeners.set(event, existing);
		}),
		channels: {
			fetch: mock((id: string) => Promise.resolve(channelStore.get(id) ?? null)),
		},
	};

	function emit(event: string, ...args: unknown[]) {
		for (const cb of listeners.get(event) ?? []) {
			cb(...args);
		}
	}

	const channelStore = new Map<string, unknown>();
	function registerChannel(id: string, channel: unknown) {
		channelStore.set(id, channel);
	}

	return { mockClient, emit, registerChannel };
}

function createMockThreadChannel(id: string) {
	return {
		id,
		isThread: () => true,
		join: mock(async () => {}),
		setArchived: mock(async () => {}),
	};
}

type LogLevel = "debug" | "info" | "warn" | "error";

function createSpyLogger() {
	const calls: { level: LogLevel; args: unknown[] }[] = [];
	const logger = {
		debug: (...args: unknown[]) => calls.push({ level: "debug", args }),
		info: (...args: unknown[]) => calls.push({ level: "info", args }),
		warn: (...args: unknown[]) => calls.push({ level: "warn", args }),
		error: (...args: unknown[]) => calls.push({ level: "error", args }),
		child: () => logger,
	};
	return {
		logger,
		calls,
		warnCalls: () => calls.filter((c) => c.level === "warn"),
	};
}

// ─── Client コンストラクタをモックで差し替える ───────────────────

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
				const { mockClient } = currentMockClient;
				return mockClient as unknown as MockedClient;
			}
		},
	};
});

// ─── Tests ───────────────────────────────────────────────────────

describe("DiscordGateway - スレッドロジック ユニットテスト", () => {
	let gateway: DiscordGateway;
	let mockSetup: ReturnType<typeof createMockClient>;
	let logSpy: ReturnType<typeof createSpyLogger>;

	beforeEach(() => {
		mockSetup = createMockClient();
		currentMockClient = mockSetup;
		logSpy = createSpyLogger();
		gateway = new DiscordGateway("fake-token", logSpy.logger);
	});

	afterEach(() => {
		gateway.stop();
	});

	// ─── joinIfThread エッジケース ────────────────────────────────

	describe("joinIfThread: fetch が null を返す場合", () => {
		it("join() は呼ばれず、エラーも発生しない", async () => {
			// channelStore に登録しない → fetch は null を返す
			gateway.setHomeChannelIds(["nonexistent-id"]);
			await gateway.start();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			// warn ログが出ていないことを確認（null は正常パス、try 内で静かにスキップ）
			const warns = logSpy.warnCalls();
			const joinWarn = warns.find((w) => String(w.args[0]).includes("failed to join home thread"));
			expect(joinWarn).toBeUndefined();
		});
	});

	describe("joinIfThread: fetch がスレッドでないチャンネルを返す場合", () => {
		it("join() は呼ばれない", async () => {
			const normalChannel = {
				id: "text-channel-1",
				isThread: () => false,
				join: mock(async () => {}),
			};
			mockSetup.registerChannel("text-channel-1", normalChannel);

			gateway.setHomeChannelIds(["text-channel-1"]);
			await gateway.start();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			expect(normalChannel.join).not.toHaveBeenCalled();
		});
	});

	describe("joinIfThread: fetch が例外をスローする場合", () => {
		it("warn ログを出力し、クラッシュしない", async () => {
			mockSetup.mockClient.channels.fetch = mock(() =>
				Promise.reject(new Error("Unknown Channel")),
			);

			gateway.setHomeChannelIds(["deleted-thread-id"]);
			await gateway.start();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			const warns = logSpy.warnCalls();
			const joinWarn = warns.find((w) =>
				String(w.args[0]).includes("failed to join home thread deleted-thread-id"),
			);
			expect(joinWarn).toBeDefined();
		});
	});

	describe("joinIfThread: isThread プロパティが存在しないチャンネルの場合", () => {
		it("join() は呼ばれず、エラーも発生しない", async () => {
			const weirdChannel = { id: "weird-channel" };
			mockSetup.registerChannel("weird-channel", weirdChannel);

			gateway.setHomeChannelIds(["weird-channel"]);
			await gateway.start();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			// クラッシュしないことの確認（join が存在しないので呼ばれない）
			const warns = logSpy.warnCalls();
			const joinWarn = warns.find((w) => String(w.args[0]).includes("failed to join home thread"));
			expect(joinWarn).toBeUndefined();
		});
	});

	describe("joinIfThread: join() が失敗する場合", () => {
		it("warn ログを出力し、クラッシュしない", async () => {
			const failingThread = {
				id: "thread-join-fail",
				isThread: () => true,
				join: mock(() => Promise.reject(new Error("Missing Permissions"))),
			};
			mockSetup.registerChannel("thread-join-fail", failingThread);

			gateway.setHomeChannelIds(["thread-join-fail"]);
			await gateway.start();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			expect(failingThread.join).toHaveBeenCalled();
			const warns = logSpy.warnCalls();
			const joinWarn = warns.find((w) =>
				String(w.args[0]).includes("failed to join home thread thread-join-fail"),
			);
			expect(joinWarn).toBeDefined();
		});
	});

	describe("joinIfThread: 複数のホームチャンネルIDに対してそれぞれ fetch する", () => {
		it("全IDについて channels.fetch が呼ばれる", async () => {
			const thread1 = createMockThreadChannel("t1");
			const thread2 = createMockThreadChannel("t2");
			mockSetup.registerChannel("t1", thread1);
			mockSetup.registerChannel("t2", thread2);

			gateway.setHomeChannelIds(["t1", "t2"]);
			await gateway.start();
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 100);
			});

			expect(thread1.join).toHaveBeenCalled();
			expect(thread2.join).toHaveBeenCalled();
		});
	});

	// ─── registerThreadUpdateHandler エッジケース ─────────────────

	describe("registerThreadUpdateHandler: archived が false の場合", () => {
		it("setArchived は呼ばれない", async () => {
			const threadId = "home-thread-1";
			gateway.setHomeChannelIds([threadId]);
			await gateway.start();

			const unarchivedThread = {
				id: threadId,
				archived: false,
				setArchived: mock(async () => {}),
			};

			mockSetup.emit(Events.ThreadUpdate, {}, unarchivedThread);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(unarchivedThread.setArchived).not.toHaveBeenCalled();
		});
	});

	describe("registerThreadUpdateHandler: setArchived が失敗する場合", () => {
		it("warn ログを出力し、クラッシュしない", async () => {
			const threadId = "home-thread-2";
			gateway.setHomeChannelIds([threadId]);
			await gateway.start();

			const failingThread = {
				id: threadId,
				archived: true,
				setArchived: mock(() => Promise.reject(new Error("Missing Permissions"))),
			};

			mockSetup.emit(Events.ThreadUpdate, {}, failingThread);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(failingThread.setArchived).toHaveBeenCalledWith(false);
			const warns = logSpy.warnCalls();
			const unarchiveWarn = warns.find((w) =>
				String(w.args[0]).includes("failed to unarchive home thread"),
			);
			expect(unarchiveWarn).toBeDefined();
		});
	});

	describe("registerThreadUpdateHandler: ホーム以外のスレッドがアーカイブされた場合", () => {
		it("setArchived は呼ばれない", async () => {
			gateway.setHomeChannelIds(["home-thread-1"]);
			await gateway.start();

			const otherThread = {
				id: "other-thread",
				archived: true,
				setArchived: mock(async () => {}),
			};

			mockSetup.emit(Events.ThreadUpdate, {}, otherThread);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(otherThread.setArchived).not.toHaveBeenCalled();
		});
	});

	describe("registerThreadUpdateHandler: homeChannelIds が空の場合", () => {
		it("どのスレッドに対しても setArchived は呼ばれない", async () => {
			gateway.setHomeChannelIds([]);
			await gateway.start();

			const thread = {
				id: "any-thread",
				archived: true,
				setArchived: mock(async () => {}),
			};

			mockSetup.emit(Events.ThreadUpdate, {}, thread);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 50);
			});

			expect(thread.setArchived).not.toHaveBeenCalled();
		});
	});
});
