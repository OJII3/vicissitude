import { describe, expect, test } from "bun:test";

import type { ActionState, Importance } from "./helpers.ts";
import { JobManager } from "./job-manager.ts";
import type { JobExecutor } from "./job-manager.ts";

function flushPromises(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

const failingExecutor: JobExecutor = () => Promise.reject(new Error("失敗"));
const noopExecutor: JobExecutor = async () => {};

async function runJobs(
	manager: JobManager,
	count: number,
	prefix: string,
	executor: JobExecutor,
): Promise<void> {
	for (let i = 0; i < count; i++) {
		manager.startJob("moving", `${prefix}-${String(i)}`, executor);
		// eslint-disable-next-line no-await-in-loop
		await flushPromises();
	}
}

function setup(options?: {
	stuckFailureThreshold?: number;
	stuckPositionThreshold?: number;
	stuckTimeMsThreshold?: number;
}) {
	const events: { kind: string; description: string; importance: Importance }[] = [];
	const states: ActionState[] = [];
	const pushEvent = (kind: string, description: string, importance: Importance) => {
		events.push({ kind, description, importance });
	};
	const setActionState = (state: ActionState) => {
		states.push({ ...state });
	};
	// クールダウン・時間条件をテスト用に無効化
	const manager = new JobManager(pushEvent, setActionState, undefined, {
		cooldownMs: 0,
		stuckTimeMsThreshold: 0,
		...options,
	});
	return { manager, events, states };
}

describe("JobManager stuck detection", () => {
	test("連続 4 回失敗 + 時間条件で stuck 検知", async () => {
		const { manager, events } = setup();
		await runJobs(manager, 4, "target", failingExecutor);
		const stuckEvents = events.filter((e) => e.kind === "stuck");
		expect(stuckEvents).toHaveLength(1);
		expect(stuckEvents.at(0)?.importance).toBe("high");
		expect(stuckEvents.at(0)?.description).toContain("すべて失敗");
	});

	test("連続 3 回失敗では stuck 非検知", async () => {
		const { manager, events } = setup();
		await runJobs(manager, 3, "target", failingExecutor);
		const stuckEvents = events.filter((e) => e.kind === "stuck");
		expect(stuckEvents).toHaveLength(0);
	});

	test("位置停滞 + 時間条件で stuck 検知", () => {
		const { manager } = setup();
		manager.recordPositionSnapshot({ x: 100, y: 64, z: -200 });
		manager.recordPositionSnapshot({ x: 101, y: 64, z: -200 });
		manager.recordPositionSnapshot({ x: 100, y: 64, z: -201 });

		const result = manager.isStuck();
		expect(result.stuck).toBe(true);
		expect(result.reason).toContain("位置停滞");
	});

	test("位置が十分移動していれば stuck 非検知", () => {
		const { manager } = setup();
		manager.recordPositionSnapshot({ x: 100, y: 64, z: -200 });
		manager.recordPositionSnapshot({ x: 105, y: 64, z: -200 });
		manager.recordPositionSnapshot({ x: 110, y: 64, z: -200 });

		const result = manager.isStuck();
		expect(result.stuck).toBe(false);
	});

	test("成功ジョブで stuckNotified がリセットされる", async () => {
		const { manager, events } = setup();
		await runJobs(manager, 4, "target", failingExecutor);
		expect(events.filter((e) => e.kind === "stuck")).toHaveLength(1);

		manager.startJob("moving", "success", noopExecutor);
		await flushPromises();

		await runJobs(manager, 4, "target2", failingExecutor);
		expect(events.filter((e) => e.kind === "stuck")).toHaveLength(2);
	});

	test("stuckNotified で重複イベント防止", async () => {
		const { manager, events } = setup();
		await runJobs(manager, 4, "target", failingExecutor);
		await runJobs(manager, 4, "target2", failingExecutor);
		const stuckEvents = events.filter((e) => e.kind === "stuck");
		expect(stuckEvents).toHaveLength(1);
	});

	test("最後の成功から閾値未満の場合は stuck 非検知", async () => {
		const { manager, events } = setup({ stuckTimeMsThreshold: 600_000 });
		manager.startJob("moving", "ok", noopExecutor);
		await flushPromises();
		await runJobs(manager, 4, "fail", failingExecutor);
		const stuckEvents = events.filter((e) => e.kind === "stuck");
		expect(stuckEvents).toHaveLength(0);
	});
});
