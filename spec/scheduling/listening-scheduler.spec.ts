/* oxlint-disable require-await -- mock implementations */
import { describe, expect, mock, test } from "bun:test";

import type { NowPlayingReader } from "@vicissitude/scheduling/listening-scheduler";
import { ListeningScheduler } from "@vicissitude/scheduling/listening-scheduler";
import type { AgentResponse, AiAgent } from "@vicissitude/shared/types";

import { createMockLogger, createMockMetrics } from "../test-helpers.ts";

// ─── Mocks ───────────────────────────────────────────────────────

function createMockAgent(): AiAgent {
	return {
		send: mock(async (): Promise<AgentResponse> => ({ text: "", sessionId: "listening" })),
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

/** 固定値を返す decision 関数（確率判定を決定論化） */
function fixedDecision(result: boolean): () => boolean {
	return () => result;
}

/** tick ごとに異なる値を返す decision 関数 */
function sequenceDecision(...results: boolean[]): () => boolean {
	let idx = 0;
	return () => results[idx++] ?? false;
}

type TickFn = { tick(): Promise<void> };
type PollFn = { pollNowPlaying(): void };

// ─── Tests ───────────────────────────────────────────────────────

describe("ListeningScheduler — 公開 API 契約", () => {
	test("確率に当選したら agent.send が 1 回呼ばれる", async () => {
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

	test("確率に外れたら agent.send は呼ばれない", async () => {
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

	test("当選した場合、agent.send に sessionKey='listening' が渡される", async () => {
		const agent = createMockAgent();

		const scheduler = new ListeningScheduler({
			agent,
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(agent.send).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "listening" }));
	});

	test("nowPlayingReader.consume が track を返す → presence.setListeningActivity が呼ばれる", () => {
		const presence = createMockPresence();
		const reader = createMockNowPlayingReader([{ trackName: "群青 - YOASOBI" }]);

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: reader,
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		(scheduler as unknown as PollFn).pollNowPlaying();

		expect(presence.setListeningActivity).toHaveBeenCalledTimes(1);
		const arg = (presence.setListeningActivity.mock.calls[0] as unknown as string[])[0];
		expect(arg).toContain("群青");
		expect(arg).toContain("YOASOBI");
	});

	test("nowPlayingReader.consume が null → presence は更新されない", () => {
		const presence = createMockPresence();
		const reader = createMockNowPlayingReader([]);

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: reader,
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		(scheduler as unknown as PollFn).pollNowPlaying();

		expect(presence.setListeningActivity).not.toHaveBeenCalled();
	});

	test("外れた tick では presence は更新されない（次 tick まで継続）", async () => {
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).not.toHaveBeenCalled();
		expect(presence.clearActivity).not.toHaveBeenCalled();
	});

	test("agent.send がエラーを throw しても tick 全体は例外を投げずに完了する", async () => {
		const agent: AiAgent = {
			send: mock(async () => {
				throw new Error("agent failed");
			}),
			stop: mock(() => {}),
		};
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger,
			shouldStart: fixedDecision(true),
		});

		// tick は例外を throw しない（graceful 継続）
		await (scheduler as unknown as TickFn).tick();
		expect(logger.error).toHaveBeenCalled();
	});

	test("tick 中に再度 tick → 排他制御で 2 回目スキップ", async () => {
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

		await second;
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("previous tick still running, skipping"),
		);

		resolveSend({ text: "", sessionId: "listening" });
		await first;

		expect(agent.send).toHaveBeenCalledTimes(1);
	});

	test("start() は冪等（複数回呼んでも timer は 1 つ）", () => {
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger,
			shouldStart: fixedDecision(false),
		});

		scheduler.start();
		scheduler.start();
		void scheduler.stop();

		expect(logger.error).not.toHaveBeenCalled();
	});

	test("stop() は start() 前でも呼べる（冪等）", () => {
		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});

		expect(() => scheduler.stop()).not.toThrow();
	});

	test("成功時に success メトリクスが記録される", async () => {
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
	});

	test("エラー時に error メトリクスが記録される", async () => {
		const agent: AiAgent = {
			send: mock(async () => {
				throw new Error("boom");
			}),
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
	});

	test("活動中→睡眠時間帯への遷移で clearActivity が1回呼ばれる", async () => {
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: sequenceDecision(true, false),
		});
		const tickFn = scheduler as unknown as TickFn;

		await tickFn.tick();
		await tickFn.tick();

		expect(presence.clearActivity).toHaveBeenCalledTimes(1);
	});

	test("睡眠時間帯が続いている間は clearActivity を繰り返し呼ばない", async () => {
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: sequenceDecision(false, false),
		});
		const tickFn = scheduler as unknown as TickFn;

		await tickFn.tick();
		await tickFn.tick();

		expect(presence.clearActivity).not.toHaveBeenCalled();
	});

	test("活動時間帯が続いている間は clearActivity を呼ばない", async () => {
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence,
			nowPlayingReader: createMockNowPlayingReader(),
			logger: createMockLogger(),
			shouldStart: sequenceDecision(true, true),
		});
		const tickFn = scheduler as unknown as TickFn;

		await tickFn.tick();
		await tickFn.tick();

		expect(presence.clearActivity).not.toHaveBeenCalled();
	});
});
