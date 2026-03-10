import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { insertBridgeEvent } from "../store/mc-bridge.ts";
import { createTestDb } from "../store/test-helpers.ts";
import type { McSubBrainManagerDeps } from "./mc-sub-brain-manager.ts";
import { McSubBrainManager } from "./mc-sub-brain-manager.ts";

/** テスト用の最小限の deps を作成する */
function createTestDeps(overrides?: Partial<McSubBrainManagerDeps>): McSubBrainManagerDeps {
	return {
		db: createTestDb(),
		// oxlint-disable-next-line no-explicit-any -- テスト用の最小モック
		sessionStore: { get: mock(() => null), set: mock(() => {}), count: mock(() => 0) } as any,
		logger: {
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
		},
		root: "/tmp/test-mc-sub",
		port: 9999,
		providerId: "test-provider",
		modelId: "test-model",
		sessionMaxAgeMs: 3_600_000,
		...overrides,
	};
}

describe("McSubBrainManager", () => {
	let manager: McSubBrainManager;
	let deps: McSubBrainManagerDeps;

	beforeEach(() => {
		deps = createTestDeps();
		manager = new McSubBrainManager(deps);
	});

	afterEach(async () => {
		await manager.stop();
	});

	test("start() clears existing session lock", () => {
		// ロック挿入
		const { tryAcquireSessionLock } = require("../store/mc-bridge.ts");
		tryAcquireSessionLock(deps.db, "old-guild");

		manager.start();

		// ロックがクリアされ、再取得可能
		const result = tryAcquireSessionLock(deps.db, "new-guild");
		expect(result).toEqual({ ok: true });
	});

	test("stop() is safe to call without start()", async () => {
		await expect(manager.stop()).resolves.toBeUndefined();
	});

	test("stop() is safe to call multiple times", async () => {
		manager.start();
		await manager.stop();
		await expect(manager.stop()).resolves.toBeUndefined();
	});

	test("lifecycle start event triggers startRunner (via log)", async () => {
		manager.start();

		// lifecycle start イベントを挿入
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");

		// ポーリングが発火するのを待つ（11秒 > 10秒ポーリング間隔）
		await Bun.sleep(11_000);

		// startRunner が呼ばれたことをログで確認
		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedLog = infoCalls.some(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain started"),
		);
		expect(startedLog).toBe(true);
	}, 15_000);

	test("lifecycle stop event triggers stopRunner (via log)", async () => {
		manager.start();

		// まず start して runner を起動
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(11_000);

		// 次に stop イベント
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "stop");
		await Bun.sleep(11_000);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppedLog = infoCalls.some(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain stopped"),
		);
		expect(stoppedLog).toBe(true);
	}, 25_000);

	test("startRunner is no-op when runner already exists", async () => {
		manager.start();

		// 2回連続の start イベント
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(11_000);

		// "sub-brain started" ログは1回だけ
		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedCount = infoCalls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain started"),
		).length;
		expect(startedCount).toBe(1);
	}, 15_000);

	test("startRunner is no-op when stopping is in progress", async () => {
		manager.start();

		// start → stop を即時に挿入
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(11_000);

		// stop と同時に start を挿入
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "stop");
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(11_000);

		// stop 中に start が来ても安全に処理される（クラッシュしない）
		const errorCalls = (deps.logger.error as ReturnType<typeof mock>).mock.calls;
		const lifecycleErrors = errorCalls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("lifecycle check error"),
		);
		expect(lifecycleErrors).toHaveLength(0);
	}, 25_000);
});
