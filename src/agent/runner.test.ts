import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
	ContextBuilderPort,
	EventBuffer,
	Logger,
	OpencodeSessionEvent,
	OpencodeSessionPort,
} from "../core/types.ts";
import type { AgentProfile } from "./profile.ts";
import { AgentRunner } from "./runner.ts";

function deferred<T>() {
	let resolveDeferred!: (value: T) => void;
	let rejectDeferred!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolveDeferred = resolve;
		rejectDeferred = reject;
	});
	return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function createProfile(restartPolicy: AgentProfile["restartPolicy"] = "immediate"): AgentProfile {
	return {
		name: "conversation",
		mcpServers: {},
		builtinTools: {},
		pollingPrompt: "loop forever",
		restartPolicy,
		model: { providerId: "test-provider", modelId: "test-model" },
	};
}

function createLogger(): Logger {
	return {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
	};
}

function createContextBuilder(): ContextBuilderPort {
	return { build: mock(() => Promise.resolve("system prompt")) };
}

function createSessionStore() {
	let sessionId: string | undefined;
	let createdAt: number | undefined;
	return {
		get: mock(() => sessionId),
		getRow: mock(() => (sessionId && createdAt ? { key: "k", sessionId, createdAt } : undefined)),
		save: mock((_profile: string, _key: string, nextSessionId: string) => {
			sessionId = nextSessionId;
			createdAt = Date.now();
		}),
		delete: mock(() => {
			sessionId = undefined;
			createdAt = undefined;
		}),
	};
}

function createEventBuffer(waitImpl: (signal: AbortSignal) => Promise<void>): EventBuffer {
	return {
		append: mock(() => {}),
		waitForEvents: mock(waitImpl),
	};
}

function createSessionPort(waitImpl: () => Promise<OpencodeSessionEvent>): OpencodeSessionPort & {
	promptAsync: ReturnType<typeof mock>;
	promptAsyncAndWatchSession: ReturnType<typeof mock>;
	waitForSessionIdle: ReturnType<typeof mock>;
} {
	return {
		createSession: mock(() => Promise.resolve("session-1")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
		promptAsync: mock(() => Promise.resolve()),
		promptAsyncAndWatchSession: mock((_params, _signal) => waitImpl()),
		waitForSessionIdle: mock(waitImpl),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	};
}

const activeRunners = new Set<AgentRunner>();

afterEach(() => {
	for (const runner of activeRunners) {
		runner.stop();
	}
	activeRunners.clear();
});

describe("AgentRunner", () => {
	test("初回イベント検知後に long-lived session を起動し、idle を待たずに稼働し続ける", async () => {
		const firstEvent = deferred<void>();
		const sessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		const sessionPort = createSessionPort(() => sessionDone.promise);
		const runner = new AgentRunner({
			profile: createProfile(),
			guildId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		const loop = runner.startPollingLoop();
		await Bun.sleep(0);
		expect(sessionPort.promptAsync).toHaveBeenCalledTimes(0);

		firstEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(sessionPort.waitForSessionIdle).toHaveBeenCalledTimes(0);

		runner.stop();
		sessionDone.resolve({ type: "cancelled" });
		await loop;
	});

	test("session が idle になったら新規イベント待ちなしで再起動する", async () => {
		const firstEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		const eventBuffer = createEventBuffer(() => firstEvent.promise);
		let sessionWatchCount = 0;
		const waitForSessionIdle = mock(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});
		const sessionPort = {
			createSession: mock(() => Promise.resolve("session-1")),
			sessionExists: mock(() => Promise.resolve(false)),
			prompt: mock(() => Promise.resolve({ text: "", tokens: undefined })),
			promptAsync: mock(() => Promise.resolve()),
			promptAsyncAndWatchSession: mock((_params, _signal) => waitForSessionIdle()),
			waitForSessionIdle,
			deleteSession: mock(() => Promise.resolve()),
			close: mock(() => {}),
		} satisfies OpencodeSessionPort;
		const runner = new AgentRunner({
			profile: createProfile(),
			guildId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		const loop = runner.startPollingLoop();
		firstEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(2);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
		await loop;
	});

	test("wait_for_events ポリシーでは idle 後に再度 EventBuffer を待ってから再起動する", async () => {
		const firstEvent = deferred<void>();
		const secondEvent = deferred<void>();
		const firstSessionDone = deferred<OpencodeSessionEvent>();
		const secondSessionDone = deferred<OpencodeSessionEvent>();
		let waitCount = 0;
		const eventBuffer = createEventBuffer(() => {
			waitCount += 1;
			return waitCount === 1 ? firstEvent.promise : secondEvent.promise;
		});
		let sessionWatchCount = 0;
		const sessionPort = createSessionPort(() => {
			sessionWatchCount += 1;
			return sessionWatchCount === 1 ? firstSessionDone.promise : secondSessionDone.promise;
		});
		const runner = new AgentRunner({
			profile: createProfile("wait_for_events"),
			guildId: "guild-1",
			sessionStore: createSessionStore() as never,
			contextBuilder: createContextBuilder(),
			logger: createLogger(),
			sessionPort,
			eventBuffer,
			sessionMaxAgeMs: 3_600_000,
		});
		activeRunners.add(runner);

		const loop = runner.startPollingLoop();
		firstEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(1);

		firstSessionDone.resolve({ type: "idle" });
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(1);
		expect(eventBuffer.waitForEvents).toHaveBeenCalledTimes(2);

		secondEvent.resolve();
		await Bun.sleep(0);

		expect(sessionPort.promptAsyncAndWatchSession).toHaveBeenCalledTimes(2);

		runner.stop();
		secondSessionDone.resolve({ type: "cancelled" });
		await loop;
	});
});
