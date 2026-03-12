import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createMinecraftBrainWakeNotifier, shouldWakeMinecraftBrain } from "./brain-wake.ts";

describe("shouldWakeMinecraftBrain", () => {
	test("health medium は wake する", () => {
		expect(shouldWakeMinecraftBrain("health", "medium", "Health: 20, Food: 0")).toBe(true);
	});

	test("低重要度 chat は wake しない", () => {
		expect(shouldWakeMinecraftBrain("chat", "low", "<a> hi")).toBe(false);
	});

	test("stuck イベントで wake する", () => {
		expect(shouldWakeMinecraftBrain("stuck", "high", "直近 4 件のジョブがすべて失敗")).toBe(true);
	});
});

describe("createMinecraftBrainWakeNotifier", () => {
	test("stamp 未指定でも連続通知ごとに異なる値を書き込む", () => {
		const dir = mkdtempSync(join(tmpdir(), "vicissitude-brain-wake-"));
		const signalPath = join(dir, "brain.signal");
		const notify = createMinecraftBrainWakeNotifier(signalPath);

		notify();
		const first = readFileSync(signalPath, "utf8");
		notify();
		const second = readFileSync(signalPath, "utf8");

		expect(second).not.toBe(first);
	});
});
