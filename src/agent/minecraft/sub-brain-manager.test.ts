import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { OpencodeSessionPort } from "../../core/types.ts";
import {
	insertBridgeEvent,
	releaseSessionLockAndStop,
	tryAcquireSessionLock,
} from "../../store/mc-bridge.ts";
import { createTestDb } from "../../store/test-helpers.ts";
import type { McSubBrainManagerDeps } from "./sub-brain-manager.ts";
import { McSubBrainManager } from "./sub-brain-manager.ts";

function createMockSessionPort(): OpencodeSessionPort {
	return {
		createSession: mock(() => Promise.resolve("mock-session-id")),
		sessionExists: mock(() => Promise.resolve(false)),
		prompt: mock(() => Promise.resolve("")),
		promptAsync: mock(() => Promise.resolve()),
		waitForSessionIdle: mock(() => Promise.resolve({ type: "idle" as const })),
		deleteSession: mock(() => Promise.resolve()),
		close: mock(() => {}),
	};
}

/** テスト用ポーリング間隔（50ms で十分高速） */
const TEST_POLL_MS = 50;

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
		createSessionPort: () => createMockSessionPort(),
		providerId: "test-provider",
		modelId: "test-model",
		sessionMaxAgeMs: 3_600_000,
		lifecyclePollMs: TEST_POLL_MS,
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

	test("stop() logs lifecycle polling stop when started", async () => {
		manager.start();
		await manager.stop();

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppingLog = infoCalls.some(
			(call: unknown[]) =>
				typeof call[0] === "string" && call[0].includes("stopping lifecycle polling"),
		);
		expect(stoppingLog).toBe(true);
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

		// ポーリングが発火するのを待つ
		await Bun.sleep(TEST_POLL_MS * 3);

		// startRunner が呼ばれたことをログで確認
		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedLog = infoCalls.some(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain started"),
		);
		expect(startedLog).toBe(true);
	});

	test("lifecycle stop event triggers stopRunner (via log)", async () => {
		manager.start();

		// まず start して runner を起動
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// 次に stop イベント
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "stop");
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppedLog = infoCalls.some(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain stopped"),
		);
		expect(stoppedLog).toBe(true);
	});

	test("startRunner is no-op when runner already exists", async () => {
		manager.start();

		// 2回連続の start イベント
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// "sub-brain started" ログは1回だけ
		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedCount = infoCalls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain started"),
		).length;
		expect(startedCount).toBe(1);
	});

	test("releaseSessionLockAndStop → manager が stop を検知して runner を停止", async () => {
		const guildId = "test-guild-stop";
		manager.start();

		// ロック取得 + start
		tryAcquireSessionLock(deps.db, guildId);
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// メイン側 API: releaseSessionLockAndStop（ロック解放 + stop イベント挿入）
		const released = releaseSessionLockAndStop(deps.db, guildId);
		expect(released).toBe(true);

		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const stoppedLog = infoCalls.some(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain stopped"),
		);
		expect(stoppedLog).toBe(true);
	});

	test("stop → 再 start サイクルで sub-brain started ログが 2 回出力", async () => {
		manager.start();

		// 1回目: start
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// stop
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "stop");
		await Bun.sleep(TEST_POLL_MS * 3);

		// 2回目: start
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		const infoCalls = (deps.logger.info as ReturnType<typeof mock>).mock.calls;
		const startedCount = infoCalls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("sub-brain started"),
		).length;
		expect(startedCount).toBe(2);
	});

	test("startRunner is no-op when stopping is in progress", async () => {
		manager.start();

		// start → stop を即時に挿入
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// stop と同時に start を挿入
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "stop");
		insertBridgeEvent(deps.db, "to_sub", "lifecycle", "start");
		await Bun.sleep(TEST_POLL_MS * 3);

		// stop 中に start が来ても安全に処理される（クラッシュしない）
		const errorCalls = (deps.logger.error as ReturnType<typeof mock>).mock.calls;
		const lifecycleErrors = errorCalls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("lifecycle check error"),
		);
		expect(lifecycleErrors).toHaveLength(0);
	});
});
