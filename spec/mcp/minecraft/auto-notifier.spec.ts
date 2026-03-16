import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createAutoNotifier } from "../../../src/mcp/minecraft/auto-notifier.ts";
import { createDb, closeDb } from "@vicissitude/store/db";
import { getMcConnectionStatus, tryAcquireSessionLock } from "@vicissitude/store/mc-bridge";
import { consumeEvents } from "@vicissitude/store/queries";

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

	test("death イベントで event_buffer に report が挿入される", () => {
		({ db, dir } = setupDb());
		// guildId を mc_session_lock に登録して、対象の agentId を特定可能にする
		tryAcquireSessionLock(db, "guild-1");
		const notifier = createAutoNotifier(db);

		notifier("death", "Bot died", "high");

		const events = consumeEvents(db, "discord:guild-1");
		expect(events).toHaveLength(1);
		const payload = JSON.parse(events[0]?.payload ?? "{}");
		expect(payload.content).toBe("Bot died");
		expect(payload.metadata?.auto).toBe(true);
	});

	test("kicked イベントで event_buffer に report が挿入される", () => {
		({ db, dir } = setupDb());
		tryAcquireSessionLock(db, "guild-1");
		const notifier = createAutoNotifier(db);

		notifier("kicked", "Kicked: timeout", "high");

		const events = consumeEvents(db, "discord:guild-1");
		expect(events).toHaveLength(1);
	});

	test("disconnect イベントで接続状態が false に設定される", () => {
		({ db, dir } = setupDb());
		tryAcquireSessionLock(db, "guild-1");
		const notifier = createAutoNotifier(db);

		notifier("disconnect", "Disconnected: server closed", "high");

		const status = getMcConnectionStatus(db);
		expect(status.connected).toBe(false);
	});

	test("spawn イベントで接続状態が true に設定される", () => {
		({ db, dir } = setupDb());
		tryAcquireSessionLock(db, "guild-1");
		const notifier = createAutoNotifier(db);

		notifier("spawn", "Spawned at (0, 64, 0)", "high");

		const status = getMcConnectionStatus(db);
		expect(status.connected).toBe(true);
	});

	test("対象外のイベント種別は通知しない", () => {
		({ db, dir } = setupDb());
		tryAcquireSessionLock(db, "guild-1");
		const notifier = createAutoNotifier(db);

		notifier("chat", "<player> hello", "medium");
		notifier("health", "Health: 20, Food: 10", "low");

		const events = consumeEvents(db, "discord:guild-1");
		expect(events).toHaveLength(0);
	});

	test("同一種別のクールダウン期間中は通知をスキップする", () => {
		({ db, dir } = setupDb());
		tryAcquireSessionLock(db, "guild-1");
		const notifier = createAutoNotifier(db);

		notifier("death", "Bot died (1st)", "high");
		notifier("death", "Bot died (2nd)", "high");

		const events = consumeEvents(db, "discord:guild-1");
		expect(events).toHaveLength(1);
		const payload = JSON.parse(events[0]?.payload ?? "{}");
		expect(payload.content).toBe("Bot died (1st)");
	});

	test("異なる種別は独立してクールダウンする", () => {
		({ db, dir } = setupDb());
		tryAcquireSessionLock(db, "guild-1");
		const notifier = createAutoNotifier(db);

		notifier("death", "Bot died", "high");
		notifier("kicked", "Kicked: reason", "high");

		const events = consumeEvents(db, "discord:guild-1");
		expect(events).toHaveLength(2);
	});

	test("session lock がない場合は event_buffer に挿入されない", () => {
		({ db, dir } = setupDb());
		const notifier = createAutoNotifier(db);

		notifier("death", "Bot died", "high");

		// guildId が特定できないため挿入されない
		const events = consumeEvents(db, "discord:guild-1");
		expect(events).toHaveLength(0);
	});

	test("メトリクスが記録される", () => {
		({ db, dir } = setupDb());
		tryAcquireSessionLock(db, "guild-1");
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
