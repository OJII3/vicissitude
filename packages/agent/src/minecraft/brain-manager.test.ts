import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { MetricsCollector } from "@vicissitude/shared/types";
import { clearSessionLock, tryAcquireSessionLock } from "@vicissitude/store/mc-bridge";
import { createTestDb } from "@vicissitude/store/test-helpers";

import type { McBrainManagerDeps } from "./brain-manager.ts";
import { McBrainManager } from "./brain-manager.ts";

/** テスト用ポーリング間隔（50ms で十分高速） */
const TEST_POLL_MS = 50;

/** テスト用の最小限の deps を作成する */
function createTestDeps(overrides?: Partial<McBrainManagerDeps>): McBrainManagerDeps {
	return {
		db: createTestDb(),
		// oxlint-disable-next-line no-explicit-any -- テスト用の最小モック
		sessionStore: { get: mock(() => null), set: mock(() => {}), count: mock(() => 0) } as any,
		logger: {
			debug: mock(() => {}),
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
		},
		root: "/tmp/test-mc-sub",
		opencodePort: 9999,
		providerId: "test-provider",
		modelId: "test-model",
		sessionMaxAgeMs: 3_600_000,
		lifecyclePollMs: TEST_POLL_MS,
		...overrides,
	};
}

describe("McBrainManager", () => {
	let manager: McBrainManager;
	let deps: McBrainManagerDeps;

	beforeEach(() => {
		deps = createTestDeps();
		manager = new McBrainManager(deps);
	});

	afterEach(() => {
		manager.stop();
	});

	test("start() clears existing session lock", () => {
		// ロック挿入
		tryAcquireSessionLock(deps.db, "old-guild");

		manager.start();

		// ロックがクリアされ、再取得可能
		const result = tryAcquireSessionLock(deps.db, "new-guild");
		expect(result).toEqual({ ok: true });
	});

	test("start() logs lifecycle polling started", () => {
		manager.start();

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const pollingStartedLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("lifecycle polling started"),
		);
		expect(pollingStartedLog).toBe(true);
	});

	test("stop() logs lifecycle polling stop when started", () => {
		manager.start();
		manager.stop();

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppingLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("stopping lifecycle polling"),
		);
		expect(stoppingLog).toBe(true);
	});

	test("stop() is safe to call without start()", () => {
		expect(() => manager.stop()).not.toThrow();
	});

	test("stop() is safe to call multiple times", () => {
		manager.start();
		manager.stop();
		expect(() => manager.stop()).not.toThrow();
	});

	test("session lock 取得で agent が起動する", async () => {
		manager.start();

		// セッションロックを取得 → ポーリングが検知して agent を起動
		tryAcquireSessionLock(deps.db, "test-guild");

		// ポーリングが発火するのを待つ
		await Bun.sleep(TEST_POLL_MS * 3);

		// startRunner が呼ばれたことをログで確認
		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain started"),
		);
		expect(startedLog).toBe(true);
	});

	test("session lock 解放で agent が停止する", async () => {
		manager.start();

		// まず lock 取得して agent を起動
		tryAcquireSessionLock(deps.db, "test-guild");
		await Bun.sleep(TEST_POLL_MS * 3);

		// lock を解放して agent を停止
		clearSessionLock(deps.db);
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppedLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain stopped"),
		);
		expect(stoppedLog).toBe(true);
	});

	test("agent が既に存在する場合は二重起動しない", async () => {
		manager.start();

		// ロック取得
		tryAcquireSessionLock(deps.db, "test-guild");
		await Bun.sleep(TEST_POLL_MS * 3);

		// さらにポーリングが回っても二重起動しない
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedCount = infoCalls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain started"),
		).length;
		expect(startedCount).toBe(1);
	});

	test("stop → 再 start サイクルで minecraft brain started ログが 2 回出力", async () => {
		manager.start();

		// 1回目: lock 取得
		tryAcquireSessionLock(deps.db, "test-guild");
		await Bun.sleep(TEST_POLL_MS * 3);

		// lock 解放で停止
		clearSessionLock(deps.db);
		await Bun.sleep(TEST_POLL_MS * 3);

		// 2回目: 再度 lock 取得
		tryAcquireSessionLock(deps.db, "test-guild-2");
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedCount = infoCalls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain started"),
		).length;
		expect(startedCount).toBe(2);
	});

	test("lifecycle check でエラーが発生しても安全に処理される", async () => {
		manager.start();

		// ロック取得 → 解放 → 再取得を高速に行う
		tryAcquireSessionLock(deps.db, "test-guild");
		await Bun.sleep(TEST_POLL_MS * 3);

		clearSessionLock(deps.db);
		tryAcquireSessionLock(deps.db, "test-guild-2");
		await Bun.sleep(TEST_POLL_MS * 3);

		// エラーが発生していないことを確認
		const errorCalls = (deps.logger.error as ReturnType<typeof mock>).mock.calls;
		const lifecycleErrors = errorCalls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("lifecycle check error"),
		);
		expect(lifecycleErrors).toHaveLength(0);
	});

	test("metrics を渡した場合に createAgent がエラーなく動作する", async () => {
		const metrics: MetricsCollector = {
			incrementCounter: mock(() => {}),
			addCounter: mock(() => {}),
			setGauge: mock(() => {}),
			incrementGauge: mock(() => {}),
			decrementGauge: mock(() => {}),
			observeHistogram: mock(() => {}),
		};
		const depsWithMetrics = createTestDeps({ metrics });
		const mgr = new McBrainManager(depsWithMetrics);
		mgr.start();

		tryAcquireSessionLock(depsWithMetrics.db, "test-guild-metrics");
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (depsWithMetrics.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain started"),
		);
		expect(startedLog).toBe(true);
		mgr.stop();
	});
});
