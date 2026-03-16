import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import { createMockLogger, createMockMetrics } from "../../../spec/test-helpers.ts";
import type { AiAgent, HeartbeatConfig } from "@vicissitude/shared/types";
import { HeartbeatScheduler } from "./heartbeat-scheduler.ts";

const TEMP_ROOT = `/tmp/vicissitude-heartbeat-scheduler-${process.pid}`;

function createMockAgent(): AiAgent {
	return {
		send: mock(() => Promise.resolve({ text: "", sessionId: "session-1" })),
		stop: mock(() => {}),
	};
}

async function writeHeartbeatConfig(config: HeartbeatConfig): Promise<void> {
	const dir = join(TEMP_ROOT, "data");
	mkdirSync(dir, { recursive: true });
	await Bun.write(join(dir, "heartbeat-config.json"), JSON.stringify(config, null, 2));
}

afterEach(() => {
	if (existsSync(TEMP_ROOT)) {
		rmSync(TEMP_ROOT, { recursive: true, force: true });
	}
});

describe("HeartbeatScheduler", () => {
	test("due reminder がないときは HEARTBEAT_REMINDERS_EXECUTED を増やさない", async () => {
		await writeHeartbeatConfig({
			baseIntervalMinutes: 30,
			reminders: [],
		});
		const metrics = createMockMetrics();
		const scheduler = new HeartbeatScheduler(
			createMockAgent(),
			createMockLogger(),
			metrics,
			TEMP_ROOT,
		);

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(metrics.incrementCounter).not.toHaveBeenCalledWith("heartbeat_reminders_executed_total");
	});

	test("due reminder があるときだけ HEARTBEAT_REMINDERS_EXECUTED を増やす", async () => {
		await writeHeartbeatConfig({
			baseIntervalMinutes: 30,
			reminders: [
				{
					id: "due-1",
					description: "check home",
					schedule: { type: "interval", minutes: 1 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		});
		const metrics = createMockMetrics();
		const scheduler = new HeartbeatScheduler(
			createMockAgent(),
			createMockLogger(),
			metrics,
			TEMP_ROOT,
		);

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(metrics.incrementCounter).toHaveBeenCalledWith("heartbeat_reminders_executed_total");
	});
});
