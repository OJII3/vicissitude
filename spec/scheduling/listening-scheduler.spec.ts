/* oxlint-disable require-await -- mock implementations */
import { describe, expect, mock, test } from "bun:test";

import { ListeningScheduler } from "@vicissitude/scheduling/listening-scheduler";
import type { AgentResponse, AiAgent } from "@vicissitude/shared/types";

import { createMockLogger, createMockMetrics } from "../test-helpers.ts";

// ─── Mocks ───────────────────────────────────────────────────────

function createMockAgent(responseText = "NOW_PLAYING: 夜に駆ける - YOASOBI"): AiAgent {
	return {
		send: mock(
			async (): Promise<AgentResponse> => ({ text: responseText, sessionId: "listening" }),
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

/** 固定値を返す decision 関数（確率判定を決定論化） */
function fixedDecision(result: boolean): () => boolean {
	return () => result;
}

type TickFn = { tick(): Promise<void> };

// ─── Tests ───────────────────────────────────────────────────────

describe("ListeningScheduler — 公開 API 契約", () => {
	test("確率に当選したら agent.send が 1 回呼ばれる", async () => {
		const agent = createMockAgent();
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(agent.send).toHaveBeenCalledTimes(1);
	});

	test("確率に外れたら agent.send は呼ばれない", async () => {
		const agent = createMockAgent();
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(false),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(agent.send).not.toHaveBeenCalled();
	});

	test("当選した場合、agent.send に sessionKey='listening' が渡される", async () => {
		const agent = createMockAgent();
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(agent.send).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "listening" }));
	});

	test("agent 応答の NOW_PLAYING 行から presence.setListeningActivity が呼ばれる", async () => {
		const agent = createMockAgent("感想を書きました。\nNOW_PLAYING: 群青 - YOASOBI");
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).toHaveBeenCalledTimes(1);
		const arg = (presence.setListeningActivity.mock.calls[0] as unknown as string[])[0];
		expect(arg).toContain("群青");
		expect(arg).toContain("YOASOBI");
	});

	test("NOW_PLAYING 行が応答に含まれない場合、presence は更新されない", async () => {
		const agent = createMockAgent("普通のテキストのみ");
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(presence.setListeningActivity).not.toHaveBeenCalled();
	});

	test("外れた tick では presence は更新されない（次 tick まで継続）", async () => {
		const agent = createMockAgent();
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
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
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(true),
		});

		// tick は例外を throw しない（graceful 継続）
		await (scheduler as unknown as TickFn).tick();
		expect(logger.error).toHaveBeenCalled();
	});

	test("tick 中に再度 tick → 排他制御で 2 回目スキップ", async () => {
		const presence = createMockPresence();
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
			presence,
			logger,
			shouldStart: fixedDecision(true),
		});
		const tickFn = scheduler as unknown as TickFn;

		const first = tickFn.tick();
		const second = tickFn.tick();

		await second;
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("前回の実行がまだ進行中、スキップ"),
		);

		resolveSend({ text: "NOW_PLAYING: x - y", sessionId: "listening" });
		await first;

		// 2 回目の tick では agent.send は呼ばれていない（1 回のみ）
		expect(agent.send).toHaveBeenCalledTimes(1);
	});

	test("start() は冪等（複数回呼んでも timer は 1 つ）", () => {
		const agent = createMockAgent();
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(false),
		});

		scheduler.start();
		scheduler.start();
		void scheduler.stop();

		// 警告やエラーが出ないこと（info ログ経由で開始は 1 回のみ）
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("stop() は start() 前でも呼べる（冪等）", () => {
		const agent = createMockAgent();
		const presence = createMockPresence();
		const logger = createMockLogger();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			shouldStart: fixedDecision(false),
		});

		expect(() => scheduler.stop()).not.toThrow();
	});

	test("成功時に success メトリクスが記録される", async () => {
		const agent = createMockAgent();
		const presence = createMockPresence();
		const logger = createMockLogger();
		const metrics = createMockMetrics();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
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
		const presence = createMockPresence();
		const logger = createMockLogger();
		const metrics = createMockMetrics();

		const scheduler = new ListeningScheduler({
			agent,
			presence,
			logger,
			metrics,
			shouldStart: fixedDecision(true),
		});
		await (scheduler as unknown as TickFn).tick();

		expect(metrics.incrementCounter).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ outcome: "error" }),
		);
	});
});
