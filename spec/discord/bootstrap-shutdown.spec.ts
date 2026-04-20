import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import { createShutdown, type ShutdownDeps } from "../../apps/discord/src/shutdown.ts";

function makeDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & { callOrder: string[] } {
	const callOrder: string[] = [];
	const track = (name: string) => () => {
		callOrder.push(name);
	};

	return {
		callOrder,
		logger: { info: mock(), error: mock(), warn: mock(), debug: mock() },
		sessionGaugeTimer: setInterval(() => {}, 100_000),
		consolidationScheduler: { stop: mock(track("consolidation")) },
		heartbeatScheduler: { stop: mock(track("heartbeatScheduler")) },
		gateway: { stop: mock(track("gateway")) },
		gatewayServer: {
			stop: mock(() => {
				callOrder.push("gatewayServer");
				return Promise.resolve();
			}),
		},
		mcBrainManager: { stop: mock(track("mcBrainManager")) },
		heartbeatRouter: { stop: mock(track("heartbeatRouter")) },
		routingAgent: { stop: mock(track("routingAgent")) },
		metricsServer: { stop: mock(track("metrics")) },
		factReader: { close: mock(track("factReader")) },
		chatAdapter: { close: mock(track("chatAdapter")) },
		recorder: { close: mock(track("recorder")) },
		mcProcess: { kill: mock(track("mcProcess")) },
		closeDb: mock(track("db")),
		...overrides,
	};
}

describe("createShutdown()", () => {
	let exitSpy: ReturnType<typeof spyOn>;
	let clearIntervalSpy: ReturnType<typeof spyOn>;
	let setTimeoutSpy: ReturnType<typeof spyOn>;
	let clearTimeoutSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as unknown as (
			code?: number,
		) => never);
		clearIntervalSpy = spyOn(globalThis, "clearInterval");
		setTimeoutSpy = spyOn(globalThis, "setTimeout").mockReturnValue(
			42 as unknown as ReturnType<typeof setTimeout>,
		);
		clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
	});

	afterEach(() => {
		exitSpy.mockRestore();
		clearIntervalSpy.mockRestore();
		setTimeoutSpy.mockRestore();
		clearTimeoutSpy.mockRestore();
	});

	describe("シャットダウン順序", () => {
		it("14 コンポーネントが定義順にシャットダウンされる", async () => {
			const deps = makeDeps();
			// clearInterval のスパイで sessionGauge の順序を記録
			clearIntervalSpy.mockImplementation((..._args: unknown[]) => {
				deps.callOrder.push("sessionGauge");
			});

			const shutdown = createShutdown(deps);
			await shutdown();

			expect(deps.callOrder).toEqual([
				"sessionGauge",
				"consolidation",
				"heartbeatScheduler",
				"gateway",
				"gatewayServer",
				"mcBrainManager",
				"heartbeatRouter",
				"routingAgent",
				"metrics",
				"factReader",
				"chatAdapter",
				"recorder",
				"mcProcess",
				"db",
			]);
		});
	});

	describe("エラー分離", () => {
		it("一部コンポーネントがエラーをスローしても残りのシャットダウン処理が続行される", async () => {
			const deps = makeDeps({
				gateway: {
					stop: mock(() => {
						throw new Error("gateway error");
					}),
				},
				heartbeatRouter: {
					stop: mock(() => {
						throw new Error("heartbeatRouter error");
					}),
				},
			});
			clearIntervalSpy.mockImplementation((..._args: unknown[]) => {
				deps.callOrder.push("sessionGauge");
			});

			const shutdown = createShutdown(deps);
			await shutdown();

			// gateway と heartbeatRouter がエラーでも、後続のコンポーネントがシャットダウンされる
			expect(deps.callOrder).toContain("metrics");
			expect(deps.callOrder).toContain("factReader");
			expect(deps.callOrder).toContain("db");
			// process.exit(0) が呼ばれる（正常終了）
			expect(exitSpy).toHaveBeenCalledWith(0);
			// エラーがログに記録される
			expect(deps.logger.error).toHaveBeenCalledTimes(2);
		});
	});

	describe("強制終了タイマーのキャンセル", () => {
		it("正常終了時に 5 秒後の強制終了タイマーがキャンセルされる", async () => {
			const deps = makeDeps();
			const shutdown = createShutdown(deps);
			await shutdown();

			// setTimeout で 5000ms の強制終了タイマーが設定される
			expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
			// clearTimeout で強制終了タイマーがキャンセルされる
			expect(clearTimeoutSpy).toHaveBeenCalledWith(42);
			// process.exit(0) が呼ばれる
			expect(exitSpy).toHaveBeenCalledWith(0);
		});
	});

	describe("二重呼び出し防止", () => {
		it("shuttingDown フラグにより二度目の呼び出しが無視される", async () => {
			const deps = makeDeps();
			const shutdown = createShutdown(deps);

			await shutdown();
			// 一度目の呼び出しで exit が呼ばれる
			expect(exitSpy).toHaveBeenCalledTimes(1);

			exitSpy.mockClear();

			// 二度目の呼び出しは無視される
			await shutdown();
			expect(exitSpy).not.toHaveBeenCalled();
			expect(deps.closeDb).toHaveBeenCalledTimes(1);
		});
	});

	describe("オプショナル依存", () => {
		it("consolidationScheduler が undefined でも正常にスキップされる", async () => {
			const deps = makeDeps({ consolidationScheduler: undefined });
			const shutdown = createShutdown(deps);
			await shutdown();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it("mcBrainManager が undefined でも正常にスキップされる", async () => {
			const deps = makeDeps({ mcBrainManager: undefined });
			const shutdown = createShutdown(deps);
			await shutdown();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it("chatAdapter が undefined でも正常にスキップされる", async () => {
			const deps = makeDeps({ chatAdapter: undefined });
			const shutdown = createShutdown(deps);
			await shutdown();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it("recorder が undefined でも正常にスキップされる", async () => {
			const deps = makeDeps({ recorder: undefined });
			const shutdown = createShutdown(deps);
			await shutdown();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it("mcProcess が undefined でも正常にスキップされる", async () => {
			const deps = makeDeps({ mcProcess: undefined });
			const shutdown = createShutdown(deps);
			await shutdown();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it("mcProcess が null でも正常にスキップされる", async () => {
			const deps = makeDeps({ mcProcess: null });
			const shutdown = createShutdown(deps);
			await shutdown();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it("全オプショナル依存が undefined でも正常にシャットダウンされる", async () => {
			const deps = makeDeps({
				consolidationScheduler: undefined,
				mcBrainManager: undefined,
				chatAdapter: undefined,
				recorder: undefined,
				mcProcess: undefined,
			});
			clearIntervalSpy.mockImplementation((..._args: unknown[]) => {
				deps.callOrder.push("sessionGauge");
			});

			const shutdown = createShutdown(deps);
			await shutdown();

			// オプショナルはスキップされ、必須コンポーネントのみシャットダウンされる
			expect(deps.callOrder).toEqual([
				"sessionGauge",
				"heartbeatScheduler",
				"gateway",
				"gatewayServer",
				"heartbeatRouter",
				"routingAgent",
				"metrics",
				"factReader",
				"db",
			]);
			expect(exitSpy).toHaveBeenCalledWith(0);
		});
	});
});
