import { describe, expect, test } from "bun:test";

import {
	consumeBridgeEventsByType,
	insertBridgeEvent,
	releaseSessionLockAndStop,
	tryAcquireSessionLock,
} from "../../store/mc-bridge.ts";
import { createTestDb } from "../../store/test-helpers.ts";

describe("mc-bridge ラウンドトリップ結合テスト", () => {
	test("Discord→Minecraft→Discord のラウンドトリップ", () => {
		const db = createTestDb();

		// Discord 側: command を挿入（to_minecraft）
		insertBridgeEvent(db, "to_minecraft", "command", "木を伐採して");

		// Minecraft 側: command を消費
		const commands = consumeBridgeEventsByType(db, "to_minecraft", "command");
		expect(commands).toHaveLength(1);
		expect(commands.at(0)?.payload).toBe("木を伐採して");

		// Minecraft 側: report を挿入（to_discord）
		insertBridgeEvent(
			db,
			"to_discord",
			"report",
			JSON.stringify({ message: "木を5本伐採した", importance: "medium" }),
		);

		// Discord 側: report を消費
		const reports = consumeBridgeEventsByType(db, "to_discord", "report");
		expect(reports).toHaveLength(1);
		const payload = JSON.parse(reports.at(0)?.payload ?? "{}");
		expect(payload.message).toBe("木を5本伐採した");
	});

	test("lifecycle start → stop の完全フロー", () => {
		const db = createTestDb();
		const guildId = "test-guild-123";

		// ロック取得
		const lock = tryAcquireSessionLock(db, guildId);
		expect(lock).toEqual({ ok: true });

		// start イベント挿入
		insertBridgeEvent(db, "to_minecraft", "lifecycle", "start");

		// Minecraft 側で start を検知
		const startEvents = consumeBridgeEventsByType(db, "to_minecraft", "lifecycle");
		expect(startEvents).toHaveLength(1);
		expect(startEvents.at(0)?.payload).toBe("start");

		// Discord 側: releaseSessionLockAndStop（ロック解放 + stop イベント挿入）
		const released = releaseSessionLockAndStop(db, guildId);
		expect(released).toBe(true);

		// Minecraft 側で stop を検知
		const stopEvents = consumeBridgeEventsByType(db, "to_minecraft", "lifecycle");
		expect(stopEvents).toHaveLength(1);
		expect(stopEvents.at(0)?.payload).toBe("stop");
	});

	test("コマンド順序保持: 複数コマンドが id 昇順で返る", () => {
		const db = createTestDb();

		insertBridgeEvent(db, "to_minecraft", "command", "first");
		insertBridgeEvent(db, "to_minecraft", "command", "second");
		insertBridgeEvent(db, "to_minecraft", "command", "third");

		const commands = consumeBridgeEventsByType(db, "to_minecraft", "command");
		expect(commands).toHaveLength(3);
		expect(commands.at(0)?.payload).toBe("first");
		expect(commands.at(1)?.payload).toBe("second");
		expect(commands.at(2)?.payload).toBe("third");

		// id が昇順であることを確認
		const id0 = commands.at(0)?.id ?? 0;
		const id1 = commands.at(1)?.id ?? 0;
		const id2 = commands.at(2)?.id ?? 0;
		expect(id0).toBeLessThan(id1);
		expect(id1).toBeLessThan(id2);
	});

	test("方向の独立性: to_minecraft の消費が to_discord に影響しない", () => {
		const db = createTestDb();

		insertBridgeEvent(db, "to_minecraft", "command", "minecraft向け");
		insertBridgeEvent(db, "to_discord", "report", "discord向け");

		// to_minecraft だけ消費
		const subEvents = consumeBridgeEventsByType(db, "to_minecraft", "command");
		expect(subEvents).toHaveLength(1);

		// to_discord は未消費のまま
		const mainEvents = consumeBridgeEventsByType(db, "to_discord", "report");
		expect(mainEvents).toHaveLength(1);
		expect(mainEvents.at(0)?.payload).toBe("discord向け");
	});
});
