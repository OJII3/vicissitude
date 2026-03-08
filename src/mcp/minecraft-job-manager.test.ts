import { describe, expect, test } from "bun:test";

import type { ActionState, Importance } from "./minecraft-helpers.ts";
import { JobManager } from "./minecraft-job-manager.ts";
import type { JobExecutor } from "./minecraft-job-manager.ts";

function setup() {
	const events: { kind: string; description: string; importance: Importance }[] = [];
	const states: ActionState[] = [];
	const pushEvent = (kind: string, description: string, importance: Importance) => {
		events.push({ kind, description, importance });
	};
	const setActionState = (state: ActionState) => {
		states.push({ ...state });
	};
	const manager = new JobManager(pushEvent, setActionState);
	return { manager, events, states };
}

// 永遠に終わらない executor
const hangingExecutor: JobExecutor = () => new Promise(() => {});

// 即座に完了する executor
const noopExecutor: JobExecutor = async () => {};

// 即座に失敗する executor
const failingExecutor: JobExecutor = () => Promise.reject(new Error("パスが見つからない"));

// no-op progress callback
const noopProgress = (_p: string): void => {};

/** Promise を即座に解決させるヘルパー */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

describe("JobManager", () => {
	test("startJob は即座に jobId を返す", () => {
		const { manager } = setup();
		const jobId = manager.startJob("moving", "(10, 64, -20)", hangingExecutor);
		expect(jobId).toMatch(/^job-\d+$/);
	});

	test("startJob で actionState が更新される", () => {
		const { manager, states } = setup();
		const jobId = manager.startJob("moving", "(10, 64, -20)", hangingExecutor);
		expect(states).toContainEqual({
			type: "moving",
			target: "(10, 64, -20)",
			jobId,
		});
	});

	test("getCurrentJob が実行中ジョブを返す", () => {
		const { manager } = setup();
		expect(manager.getCurrentJob()).toBeNull();
		const jobId = manager.startJob("following", "ojii3", hangingExecutor);
		const job = manager.getCurrentJob();
		expect(job).not.toBeNull();
		expect(job?.id).toBe(jobId);
		expect(job?.type).toBe("following");
		expect(job?.status).toBe("running");
	});

	test("ジョブ完了時に actionState が idle になる", async () => {
		const { manager, states } = setup();
		manager.startJob("moving", "(10, 64, -20)", noopExecutor);
		await flushPromises();
		const lastState = states.at(-1);
		expect(lastState?.type).toBe("idle");
		expect(manager.getCurrentJob()).toBeNull();
	});

	test("ジョブ完了時にイベントが記録される", async () => {
		const { manager, events } = setup();
		manager.startJob("moving", "(10, 64, -20)", noopExecutor);
		await flushPromises();
		expect(events).toContainEqual({
			kind: "job",
			description: "ジョブ完了: moving → (10, 64, -20)",
			importance: "low",
		});
	});

	test("ジョブ失敗時にエラーイベントが記録される", async () => {
		const { manager, events } = setup();
		manager.startJob("moving", "(10, 64, -20)", failingExecutor);
		await flushPromises();
		expect(events).toContainEqual({
			kind: "job",
			description: "ジョブ失敗: moving → (10, 64, -20) (パスが見つからない)",
			importance: "medium",
		});
	});

	test("cancelCurrentJob でジョブがキャンセルされる", () => {
		const { manager, events } = setup();
		let aborted = false;
		const executor: JobExecutor = async (signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			});
		};
		manager.startJob("following", "ojii3", executor);
		const cancelled = manager.cancelCurrentJob();
		expect(cancelled).toBe(true);
		expect(aborted).toBe(true);
		expect(manager.getCurrentJob()).toBeNull();
		expect(events).toContainEqual({
			kind: "job",
			description: "ジョブキャンセル: following → ojii3",
			importance: "low",
		});
	});

	test("cancelCurrentJob はジョブがない場合 false を返す", () => {
		const { manager } = setup();
		expect(manager.cancelCurrentJob()).toBe(false);
	});

	test("新ジョブ開始時に既存ジョブが自動キャンセルされる", () => {
		const { manager, events } = setup();
		let firstAborted = false;
		const executor1: JobExecutor = async (signal) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					firstAborted = true;
					reject(new Error("aborted"));
				});
			});
		};
		manager.startJob("following", "ojii3", executor1);
		manager.startJob("moving", "(0, 64, 0)", hangingExecutor);
		expect(firstAborted).toBe(true);
		const job = manager.getCurrentJob();
		expect(job?.type).toBe("moving");
		expect(events).toContainEqual({
			kind: "job",
			description: "ジョブキャンセル: following → ojii3",
			importance: "low",
		});
	});

	test("updateProgress で進捗が actionState に反映される", async () => {
		const { manager, states } = setup();
		let progressFn: (p: string) => void = noopProgress;
		const executor: JobExecutor = async (_signal, updateProgress) => {
			progressFn = updateProgress;
			// 永遠に待機
			await new Promise(() => {});
		};
		manager.startJob("collecting", "oak_log", executor);
		await flushPromises();
		progressFn("3/10 採集済み");
		const progressState = states.find((s) => s.progress === "3/10 採集済み");
		expect(progressState).toBeDefined();
		expect(progressState?.type).toBe("collecting");
	});

	test("getRecentJobs が完了済みジョブを返す", async () => {
		const { manager } = setup();
		manager.startJob("moving", "A", noopExecutor);
		await flushPromises();
		manager.startJob("collecting", "B", noopExecutor);
		await flushPromises();
		const recent = manager.getRecentJobs(5);
		expect(recent).toHaveLength(2);
		expect(recent.at(0)?.target).toBe("A");
		expect(recent.at(1)?.target).toBe("B");
	});

	test("getRecentJobs の limit が効く", async () => {
		const { manager } = setup();
		manager.startJob("moving", "A", noopExecutor);
		await flushPromises();
		manager.startJob("moving", "B", noopExecutor);
		await flushPromises();
		manager.startJob("moving", "C", noopExecutor);
		await flushPromises();
		const recent = manager.getRecentJobs(2);
		expect(recent).toHaveLength(2);
		expect(recent.at(0)?.target).toBe("B");
		expect(recent.at(1)?.target).toBe("C");
	});
});
