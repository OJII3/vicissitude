import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createDb, closeDb } from "../../store/db.ts";
import { peekBridgeEvents } from "../../store/mc-bridge.ts";
import { createAutoNotifier } from "./auto-notifier.ts";

function setupDb() {
	const dir = mkdtempSync(join(tmpdir(), "vicissitude-auto-notifier-"));
	const db = createDb(dir);
	return { db, dir };
}

describe("createAutoNotifier", () => {
	let db: ReturnType<typeof createDb>;
	let dir: string;

	afterEach(() => {
		if (db) closeDb(db);
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("death イベントでブリッジに report が挿入される", () => {
		({ db, dir } = setupDb());
		const notifier = createAutoNotifier(db);

		notifier("death", "Bot died", "high");

		const events = peekBridgeEvents(db, "to_discord");
		expect(events).toHaveLength(1);
		const first = events.at(0);
		expect(first?.type).toBe("report");
		const payload = JSON.parse(first?.payload ?? "{}");
		expect(payload.message).toBe("Bot died");
		expect(payload.auto).toBe(true);
	});

	test("kicked イベントでブリッジに report が挿入される", () => {
		({ db, dir } = setupDb());
		const notifier = createAutoNotifier(db);

		notifier("kicked", "Kicked: timeout", "high");

		const events = peekBridgeEvents(db, "to_discord");
		expect(events).toHaveLength(1);
	});

	test("disconnect イベントでブリッジに report が挿入される", () => {
		({ db, dir } = setupDb());
		const notifier = createAutoNotifier(db);

		notifier("disconnect", "Disconnected: server closed", "high");

		const events = peekBridgeEvents(db, "to_discord");
		expect(events).toHaveLength(1);
	});

	test("対象外のイベント種別は通知しない", () => {
		({ db, dir } = setupDb());
		const notifier = createAutoNotifier(db);

		notifier("chat", "<player> hello", "medium");
		notifier("health", "Health: 20, Food: 10", "low");
		notifier("spawn", "Spawned at (0, 64, 0)", "high");

		const events = peekBridgeEvents(db, "to_discord");
		expect(events).toHaveLength(0);
	});

	test("同一種別のクールダウン期間中は通知をスキップする", () => {
		({ db, dir } = setupDb());
		const notifier = createAutoNotifier(db);

		notifier("death", "Bot died (1st)", "high");
		notifier("death", "Bot died (2nd)", "high");

		const events = peekBridgeEvents(db, "to_discord");
		expect(events).toHaveLength(1);
		const payload = JSON.parse(events.at(0)?.payload ?? "{}");
		expect(payload.message).toBe("Bot died (1st)");
	});

	test("異なる種別は独立してクールダウンする", () => {
		({ db, dir } = setupDb());
		const notifier = createAutoNotifier(db);

		notifier("death", "Bot died", "high");
		notifier("kicked", "Kicked: reason", "high");

		const events = peekBridgeEvents(db, "to_discord");
		expect(events).toHaveLength(2);
	});

	test("メトリクスが記録される", () => {
		({ db, dir } = setupDb());
		const calls: { name: string; labels: Record<string, string> }[] = [];
		const metrics = {
			incrementCounter: (name: string, labels?: Record<string, string>) => {
				calls.push({ name, labels: labels ?? {} });
			},
			addCounter: () => {},
			setGauge: () => {},
			incrementGauge: () => {},
			decrementGauge: () => {},
			observeHistogram: () => {},
		};
		const notifier = createAutoNotifier(db, metrics);

		notifier("death", "Bot died", "high");

		expect(calls).toHaveLength(1);
		expect(calls.at(0)?.labels).toEqual({ kind: "death" });
	});
});
