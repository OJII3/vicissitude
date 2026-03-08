import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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

/** Promise を即座に解決させるヘルパー */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("JobManager", () => {
	test("startJob は即座に jobId を返す", () => {
		const { manager } = setup();
		const executor: JobExecutor = () => new Promise(() => {}); // 永遠に終わらない
		const jobId = manager.startJob("moving", "(10, 64, -20)", executor);
		expect(jobId).toMatch(/^job-\d+$/);
	});

	test("startJob で actionState が更新される", () => {
		const { manager, states } = setup();
		const executor: JobExecutor = () => new Promise(() => {});
		const jobId = manager.startJob("moving", "(10, 64, -20)", executor);
		expect(states).toContainEqual({
			type: "moving",
			target: "(10, 64, -20)",
			jobId,
		});
	});

	test("getCurrentJob が実行中ジョブを返す", () => {
		const { manager } = setup();
		expect(manager.getCurrentJob()).toBeNull();
		const executor: JobExecutor = () => new Promise(() => {});
		const jobId = manager.startJob("following", "ojii3", executor);
		const job = manager.getCurrentJob();
		expect(job).not.toBeNull();
		expect(job!.id).toBe(jobId);
		expect(job!.type).toBe("following");
		expect(job!.status).toBe("running");
	});

	test("ジョブ完了時に actionState が idle になる", async () => {
		const { manager, states } = setup();
		const executor: JobExecutor = async () => {};
		manager.startJob("moving", "(10, 64, -20)", executor);
		await flushPromises();
		const lastState = states[states.length - 1];
		expect(lastState.type).toBe("idle");
		expect(manager.getCurrentJob()).toBeNull();
	});

	test("ジョブ完了時にイベントが記録される", async () => {
		const { manager, events } = setup();
		const executor: JobExecutor = async () => {};
		manager.startJob("moving", "(10, 64, -20)", executor);
		await flushPromises();
		expect(events).toContainEqual({
			kind: "job",
			description: "ジョブ完了: moving → (10, 64, -20)",
			importance: "low",
		});
	});

	test("ジョブ失敗時にエラーイベントが記録される", async () => {
		const { manager, events } = setup();
		const executor: JobExecutor = async () => {
			throw new Error("パスが見つからない");
		};
		manager.startJob("moving", "(10, 64, -20)", executor);
		await flushPromises();
		expect(events).toContainEqual({
			kind: "job",
			description: "ジョブ失敗: moving → (10, 64, -20) (パスが見つからない)",
			importance: "medium",
		});
	});

	test("cancelCurrentJob でジョブがキャンセルされる", async () => {
		const { manager, events } = setup();
		let aborted = false;
		const executor: JobExecutor = async (signal) => {
			await new Promise<void>((resolve, reject) => {
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

	test("新ジョブ開始時に既存ジョブが自動キャンセルされる", async () => {
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
		const executor2: JobExecutor = () => new Promise(() => {});
		manager.startJob("following", "ojii3", executor1);
		manager.startJob("moving", "(0, 64, 0)", executor2);
		expect(firstAborted).toBe(true);
		const job = manager.getCurrentJob();
		expect(job!.type).toBe("moving");
		expect(events).toContainEqual({
			kind: "job",
			description: "ジョブキャンセル: following → ojii3",
			importance: "low",
		});
	});

	test("updateProgress で進捗が actionState に反映される", async () => {
		const { manager, states } = setup();
		let progressFn: ((p: string) => void) | null = null;
		const executor: JobExecutor = async (_signal, updateProgress) => {
			progressFn = updateProgress;
			await new Promise(() => {}); // 永遠に待機
		};
		manager.startJob("collecting", "oak_log", executor);
		await flushPromises();
		expect(progressFn).not.toBeNull();
		progressFn!("3/10 採集済み");
		const progressState = states.find((s) => s.progress === "3/10 採集済み");
		expect(progressState).toBeDefined();
		expect(progressState!.type).toBe("collecting");
	});

	test("getRecentJobs が完了済みジョブを返す", async () => {
		const { manager } = setup();
		const executor: JobExecutor = async () => {};
		manager.startJob("moving", "A", executor);
		await flushPromises();
		manager.startJob("collecting", "B", executor);
		await flushPromises();
		const recent = manager.getRecentJobs(5);
		expect(recent).toHaveLength(2);
		expect(recent[0].target).toBe("A");
		expect(recent[1].target).toBe("B");
	});

	test("getRecentJobs の limit が効く", async () => {
		const { manager } = setup();
		const executor: JobExecutor = async () => {};
		manager.startJob("moving", "A", executor);
		await flushPromises();
		manager.startJob("moving", "B", executor);
		await flushPromises();
		manager.startJob("moving", "C", executor);
		await flushPromises();
		const recent = manager.getRecentJobs(2);
		expect(recent).toHaveLength(2);
		expect(recent[0].target).toBe("B");
		expect(recent[1].target).toBe("C");
	});
});
