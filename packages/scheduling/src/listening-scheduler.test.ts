import { afterEach, describe, expect, mock, test } from "bun:test";

import { createMockLogger, createMockMetrics } from "@vicissitude/shared/test-helpers";
import type { AgentResponse, AiAgent } from "@vicissitude/shared/types";

import { ListeningScheduler } from "./listening-scheduler.ts";

// ─── Helpers ─────────────────────────────────────────────────────

function createMockAgent(responseText = "NOW_PLAYING: 夜に駆ける - YOASOBI"): AiAgent {
	return {
		send: mock(
			(): Promise<AgentResponse> => Promise.resolve({ text: responseText, sessionId: "listening" }),
		),
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

	test("start() で setInterval が呼ばれる", () => {
		const setIntervalMock = mock(
			(..._args: unknown[]) => 42 as unknown as ReturnType<typeof setInterval>,
		);
		globalThis.setInterval = setIntervalMock as unknown as typeof setInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();

		expect(setIntervalMock).toHaveBeenCalledTimes(1);
		// interval = 240_000 ms
		expect(setIntervalMock.mock.calls[0]?.[1]).toBe(240_000);

		void scheduler.stop();
	});

	test("stop() で clearInterval が呼ばれる", async () => {
		const timerId = 999 as unknown as ReturnType<typeof setInterval>;
		globalThis.setInterval = mock(() => timerId) as unknown as typeof setInterval;
		const clearIntervalMock = mock((_id: unknown) => {});
		globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();
		await scheduler.stop();

		expect(clearIntervalMock).toHaveBeenCalledTimes(1);
		expect(clearIntervalMock.mock.calls[0]?.[0]).toBe(timerId);
	});

	test("start() の冪等性: 2 回呼んでも setInterval は 1 回だけ", () => {
		const setIntervalMock = mock(
			(..._args: unknown[]) => 42 as unknown as ReturnType<typeof setInterval>,
		);
		globalThis.setInterval = setIntervalMock as unknown as typeof setInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();
		scheduler.start();

		expect(setIntervalMock).toHaveBeenCalledTimes(1);

		void scheduler.stop();
	});

	test("stop() 後の timer 解除: timer が null になり再度 stop() しても clearInterval は呼ばれない", async () => {
		const timerId = 42 as unknown as ReturnType<typeof setInterval>;
		globalThis.setInterval = mock(() => timerId) as unknown as typeof setInterval;
		const clearIntervalMock = mock((_id: unknown) => {});
		globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval;

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
			logger: createMockLogger(),
			shouldStart: fixedDecision(false),
		});
		scheduler.start();
		await scheduler.stop();
		await scheduler.stop();

		expect(clearIntervalMock).toHaveBeenCalledTimes(1);
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

// ─── NOW_PLAYING 正規表現のパースエッジケース ────────────────────

describe("ListeningScheduler — NOW_PLAYING パース", () => {
	test("NOW_PLAYING: 無し → presence 未更新", async () => {
		const agent = createMockAgent("感想を書きました。特に良い曲でした。");
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).not.toHaveBeenCalled();
	});

	test("空行のみ → presence 未更新", async () => {
		const agent = createMockAgent("\n\n\n");
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).not.toHaveBeenCalled();
	});

	test("複数行の中に NOW_PLAYING がある → 正しく抽出", async () => {
		const text = [
			"良い曲を見つけました。",
			"歌詞も素晴らしかったです。",
			"NOW_PLAYING: Lemon - 米津玄師",
		].join("\n");
		const agent = createMockAgent(text);
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).toHaveBeenCalledWith("Lemon - 米津玄師");
	});

	test("特殊文字を含む曲名 → そのまま抽出", async () => {
		const agent = createMockAgent("NOW_PLAYING: A/B (feat. C&D) [Remix] - E×F");
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).toHaveBeenCalledWith("A/B (feat. C&D) [Remix] - E×F");
	});

	test("NOW_PLAYING: の後にスペースが多い → trim される", async () => {
		const agent = createMockAgent("NOW_PLAYING:   曲名 - アーティスト  ");
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).toHaveBeenCalledWith("曲名 - アーティスト");
	});

	test("NOW_PLAYING: のみ（曲名なし）→ presence 未更新", async () => {
		const agent = createMockAgent("NOW_PLAYING:   ");
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		// 正規表現は " " にマッチするが trim() 後は空文字列 → setListeningActivity は呼ばれない
		expect(presence.setListeningActivity).not.toHaveBeenCalled();
	});

	test("行の途中に NOW_PLAYING がある → マッチする（$ は行末）", async () => {
		const agent = createMockAgent("結果: NOW_PLAYING: Test - Artist\n終了");
		const presence = createMockPresence();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger: createMockLogger(),
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).toHaveBeenCalledWith("Test - Artist");
	});
});

// ─── metrics 記録 ────────────────────────────────────────────────

describe("ListeningScheduler — metrics 記録", () => {
	test("成功時に incrementCounter と observeHistogram が呼ばれる", async () => {
		const metrics = createMockMetrics();

		const scheduler = new ListeningScheduler({
			agent: createMockAgent(),
			presence: createMockPresence(),
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
			logger: createMockLogger(),
			metrics,
			shouldStart: fixedDecision(false),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(metrics.incrementCounter).not.toHaveBeenCalled();
		expect(metrics.observeHistogram).not.toHaveBeenCalled();
	});
});
