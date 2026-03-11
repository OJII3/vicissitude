import { describe, expect, test } from "bun:test";

import type { Importance } from "./helpers.ts";
import { JobManager } from "./job-manager.ts";
import type { JobExecutor } from "./job-manager.ts";

const hangingExecutor: JobExecutor = () => new Promise(() => {});
const noopExecutor: JobExecutor = async () => {};
const failingExecutor: JobExecutor = () => Promise.reject(new Error("パスが見つからない"));

function flushPromises(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function createManager(cooldownMs: number) {
	const events: { kind: string; description: string; importance: Importance }[] = [];
	const manager = new JobManager(
		(kind, description, importance) => events.push({ kind, description, importance }),
		() => {},
		undefined,
		{ cooldownMs },
	);
	return { manager, events };
}

describe("JobManager cooldown", () => {
	test("同系統ジョブが 2 回失敗するとクールダウンに入る", async () => {
		const { manager, events } = createManager(1_000);
		manager.startJob("moving", "A", failingExecutor);
		await flushPromises();
		manager.startJob("moving", "B", failingExecutor);
		await flushPromises();

		expect(manager.getCooldowns()).toHaveLength(1);
		expect(() => manager.startJob("moving", "C", noopExecutor)).toThrow(/moving はクールダウン中/);
		expect(events.some((event) => event.description.includes("クールダウン開始: moving"))).toBe(true);
	});

	test("ジョブ完了で同系統のクールダウンが解除される", async () => {
		const { manager } = createManager(1_000);
		manager.startJob("moving", "A", failingExecutor);
		await flushPromises();
		manager.startJob("moving", "B", failingExecutor);
		await flushPromises();
		expect(manager.getCooldowns()).toHaveLength(1);

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 1_050);
		});
		manager.startJob("moving", "C", noopExecutor);
		await flushPromises();
		expect(manager.getCooldowns()).toHaveLength(0);
	});

	test("クールダウン満了時に失敗 streak もリセットされる", async () => {
		const { manager } = createManager(100);
		manager.startJob("moving", "A", failingExecutor);
		await flushPromises();
		manager.startJob("moving", "B", failingExecutor);
		await flushPromises();
		expect(manager.getCooldowns()).toHaveLength(1);

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 120);
		});

		manager.startJob("moving", "C", failingExecutor);
		await flushPromises();
		expect(manager.getCooldowns()).toHaveLength(0);
	});

	test("別ジョブ開始に伴う superseded cancel はクールダウン対象に含めない", () => {
		const { manager } = createManager(1_000);
		manager.startJob("moving", "A", hangingExecutor);
		manager.startJob("following", "ojii3", hangingExecutor);
		manager.startJob("moving", "B", hangingExecutor);
		manager.startJob("following", "ojii4", hangingExecutor);
		expect(manager.getCooldowns()).toHaveLength(0);
	});

	test("材料や作業台不足は resource shortage に分類される", async () => {
		const { manager, events } = createManager(1_000);
		manager.startJob("crafting", "stick", () =>
			Promise.reject(new Error("stick のレシピが見つからないか、材料が足りません")),
		);
		await flushPromises();
		expect(events.at(-1)?.description).toContain("resource shortage");
	});
});
