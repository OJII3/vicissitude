import { afterEach, describe, expect, mock, test } from "bun:test";

import { createMockLogger, createMockMetrics } from "@vicissitude/shared/test-helpers";
import type { AgentResponse, AiAgent } from "@vicissitude/shared/types";

import type { NowPlayingReader } from "./listening-scheduler.ts";
import { ListeningScheduler } from "./listening-scheduler.ts";

// ─── Helpers ─────────────────────────────────────────────────────

function createMockAgent(): AiAgent {
	return {
		send: mock((): Promise<AgentResponse> => Promise.resolve({ text: "", sessionId: "listening" })),
		stop: mock(() => {}),
	};
}

interface MockPresence {
	setListeningActivity: ReturnType<typeof mock>;
	clearActivity: ReturnType<typeof mock>;
}

function createMockPresence(): MockPresence {
	return {
		setListeningActivity: mock((_: string) => {}),
		clearActivity: mock(() => {}),
	};
}

function createMockNowPlayingReader(entries: { trackName: string }[] = []): NowPlayingReader {
	let idx = 0;
	return {
		consume: mock(() => {
			if (idx < entries.length) return entries[idx++] ?? null;
			return null;
		}),
	};
}

function fixedDecision(result: boolean): () => boolean {
	return () => result;
}

type TickFn = { tick(): Promise<void> };

// ─── timer の setInterval / clearInterval ────────────────────────

describe("ListeningScheduler — timer 管理", () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;

	afterEach(() => {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	});

	test("start() で setInterval が呼ばれる（tick + nowPlaying poller）", () => {
		const setIntervalMock = mock(
			(..._args: unknown[]) => 42 as unknown as ReturnType<typeof setInterval>,
		);
		globalThis.setInterval = setIntervalMock as unknown as typeof setInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();

		expect(setIntervalMock).toHaveBeenCalledTimes(2);
		// tick interval = 240_000 ms
		const intervals = setIntervalMock.mock.calls.map((c) => c[1]);
		expect(intervals).toContain(240_000);
		// now_playing poll interval = 10_000 ms
		expect(intervals).toContain(10_000);

		void scheduler.stop();
	});

	test("stop() で clearInterval が呼ばれる", async () => {
		const timerId1 = 998 as unknown as ReturnType<typeof setInterval>;
		const timerId2 = 999 as unknown as ReturnType<typeof setInterval>;
		let callCount = 0;
		globalThis.setInterval = mock(() => {
			callCount++;
			return callCount === 1 ? timerId1 : timerId2;
		}) as unknown as typeof setInterval;
		const clearIntervalMock = mock((_id: unknown) => {});
		globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();
		await scheduler.stop();

		expect(clearIntervalMock).toHaveBeenCalledTimes(2);
	});

	test("stop() 後に再度 stop() しても clearInterval は追加で呼ばれない", async () => {
		const timerId1 = 998 as unknown as ReturnType<typeof setInterval>;
		const timerId2 = 999 as unknown as ReturnType<typeof setInterval>;
		let callCount = 0;
		globalThis.setInterval = mock(() => {
			callCount++;
			return callCount === 1 ? timerId1 : timerId2;
		}) as unknown as typeof setInterval;
		const clearIntervalMock = mock((_id: unknown) => {});
		globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();
		await scheduler.stop();
		await scheduler.stop();

		expect(clearIntervalMock).toHaveBeenCalledTimes(2);
	});

	test("start() の冪等性: 2 回呼んでも setInterval は 2 回だけ（tick + poller）", () => {
		const setIntervalMock = mock(
			(..._args: unknown[]) => 42 as unknown as ReturnType<typeof setInterval>,
		);
		globalThis.setInterval = setIntervalMock as unknown as typeof setInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();
		scheduler.start();

		expect(setIntervalMock).toHaveBeenCalledTimes(2);

		void scheduler.stop();
	});
});

// ─── running flag による再入防止 ─────────────────────────────────

describe("ListeningScheduler — 再入防止", () => {
	test("tick 中に再度 tick → running flag で 2 回目がスキップされる", async () => {
		const logger = createMockLogger();
		let resolveSend!: (value: AgentResponse) => void;
		const agent: AiAgent = {
			send: mock(
				() =>
					new Promise<AgentResponse>((resolve) => {
						resolveSend = resolve;
					}),
			),
			stop: mock(() => {}),
		};

		const scheduler = new ListeningScheduler({
			agent,
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger,
			shouldStart: fixedDecision(true),
		});
		const tickFn = scheduler as unknown as TickFn;

		const first = tickFn.tick();
		const second = tickFn.tick();

		// 2 回目は即座に return
		await second;
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("previous tick still running"),
		);

		resolveSend({ text: "", sessionId: "listening" });
		await first;

		expect(agent.send).toHaveBeenCalledTimes(1);
	});
});

// ─── nowPlaying ポーリング ─────────────────────────────────────

describe("ListeningScheduler — nowPlaying ポーリング", () => {
	test("pollNowPlaying で consume の結果を presence に反映する", () => {
		const presence = createMockPresence();
		const reader = createMockNowPlayingReader([{ trackName: "Lemon - 米津玄師" }]);

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: reader,
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});

		// pollNowPlaying is private, call it via tick-independent path
		(scheduler as unknown as { pollNowPlaying(): void }).pollNowPlaying();

		expect(presence.setListeningActivity).toHaveBeenCalledWith("Lemon - 米津玄師");
	});

	test("consume が null → presence 未更新", () => {
		const presence = createMockPresence();
		const reader = createMockNowPlayingReader([]);

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: reader,
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});

		(scheduler as unknown as { pollNowPlaying(): void }).pollNowPlaying();

		expect(presence.setListeningActivity).not.toHaveBeenCalled();
	});
});

// ─── fire-and-forget send ─────────────────────────────────────

describe("ListeningScheduler — executeTick (fire-and-forget)", () => {
	test("shouldStart=true → agent.send が呼ばれる", async () => {
		const agent = createMockAgent();

		const scheduler = new ListeningScheduler({
			agent,
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(agent.send).toHaveBeenCalledTimes(1);
	});

	test("shouldStart=false → agent.send は呼ばれない", async () => {
		const agent = createMockAgent();

		const scheduler = new ListeningScheduler({
			agent,
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(agent.send).not.toHaveBeenCalled();
	});
});

// ─── metrics 記録 ────────────────────────────────────────────────

describe("ListeningScheduler — metrics 記録", () => {
	test("成功時に incrementCounter と observeHistogram が呼ばれる", async () => {
		const metrics = createMockMetrics();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			metrics,
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(metrics.incrementCounter).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ outcome: "success" }),
		);
		expect(metrics.observeHistogram).toHaveBeenCalledTimes(1);
	});

	test("エラー時に error outcome で incrementCounter が呼ばれる", async () => {
		const agent: AiAgent = {
			send: mock(() => Promise.reject(new Error("agent error"))),
			stop: mock(() => {}),
		};
		const metrics = createMockMetrics();

		const scheduler = new ListeningScheduler({
			agent,
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			metrics,
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(metrics.incrementCounter).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ outcome: "error" }),
		);
		expect(metrics.observeHistogram).toHaveBeenCalledTimes(1);
	});

	test("shouldStart が false のとき metrics は記録されない", async () => {
		const metrics = createMockMetrics();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			metrics,
			shouldStart: fixedDecision(false),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(metrics.incrementCounter).not.toHaveBeenCalled();
		expect(metrics.observeHistogram).not.toHaveBeenCalled();
	});
});
