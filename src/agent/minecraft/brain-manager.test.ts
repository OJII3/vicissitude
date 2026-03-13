import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
	insertBridgeEvent,
	releaseSessionLockAndStop,
	tryAcquireSessionLock,
} from "../../store/mc-bridge.ts";
import { createTestDb } from "../../store/test-helpers.ts";
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

	test("lifecycle start event triggers startRunner (via log)", async () => {
		manager.start();

		// lifecycle start イベントを挿入
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");

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

	test("lifecycle stop event triggers stopRunner (via log)", async () => {
		manager.start();

		// まず start して runner を起動
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// 次に stop イベント
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "stop");
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppedLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain stopped"),
		);
		expect(stoppedLog).toBe(true);
	});

	test("startRunner is no-op when runner already exists", async () => {
		manager.start();

		// 2回連続の start イベント
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// "minecraft brain started" ログは1回だけ
		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedCount = infoCalls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain started"),
		).length;
		expect(startedCount).toBe(1);
	});

	test("releaseSessionLockAndStop → manager が stop を検知して runner を停止", async () => {
		const guildId = "test-guild-stop";
		manager.start();

		// ロック取得 + start
		tryAcquireSessionLock(deps.db, guildId);
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// メイン側 API: releaseSessionLockAndStop（ロック解放 + stop イベント挿入）
		const released = releaseSessionLockAndStop(deps.db, guildId);
		expect(released).toBe(true);

		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppedLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain stopped"),
		);
		expect(stoppedLog).toBe(true);
	});

	test("stop → 再 start サイクルで minecraft brain started ログが 2 回出力", async () => {
		manager.start();

		// 1回目: start
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// stop
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "stop");
		await Bun.sleep(TEST_POLL_MS * 3);

		// 2回目: start
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedCount = infoCalls.filter(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("minecraft brain started"),
		).length;
		expect(startedCount).toBe(2);
	});

	test("startRunner is no-op when stopping is in progress", async () => {
		manager.start();

		// start → stop を即時に挿入
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// stop と同時に start を挿入
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "stop");
		insertBridgeEvent(deps.db, "to_minecraft", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// stop 中に start が来ても安全に処理される（クラッシュしない）
		const errorCalls = (deps.logger.error as ReturnType<typeof mock>).mock.calls;
		const lifecycleErrors = errorCalls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("lifecycle check error"),
		);
		expect(lifecycleErrors).toHaveLength(0);
	});
});
