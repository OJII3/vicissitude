import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_BATCH_SIZE } from "@vicissitude/mcp/tools/event-helpers";
import { registerMinecraftBridgeTools } from "@vicissitude/mcp/tools/mc-bridge-minecraft";
import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
import {
	getSessionLockGuildId,
	releaseSessionLock,
	tryAcquireSessionLock,
} from "@vicissitude/store/mc-bridge";
import { appendEvent, consumeEvents } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

describe("mc-bridge ラウンドトリップ結合テスト", () => {
	test("Discord→Minecraft→Discord のラウンドトリップ", () => {
		const db = createTestDb();

		// Discord 側: delegate コマンドを event_buffer に挿入（"minecraft:brain" 宛）
		const commandEvent = {
			ts: new Date().toISOString(),
			content: "木を伐採して",
			authorId: "discord",
			authorName: "Discord Agent",
			messageId: `delegate-${Date.now()}`,
			metadata: { type: "command" },
		};
		appendEvent(db, "minecraft:brain", JSON.stringify(commandEvent));

		// Minecraft 側: コマンドを消費
		const commands = consumeEvents(db, "minecraft:brain");
		expect(commands).toHaveLength(1);
		const parsed = JSON.parse(commands.at(0)?.payload ?? "{}");
		expect(parsed.content).toBe("木を伐採して");

		// Minecraft 側: report を Discord エージェントの event_buffer に挿入
		const guildId = "test-guild-123";
		tryAcquireSessionLock(db, guildId);
		const targetAgentId = `discord:${guildId}`;
		const reportEvent = {
			ts: new Date().toISOString(),
			content: "木を5本伐採した",
			authorId: "minecraft",
			authorName: "Minecraft Agent",
			messageId: `mc-report-${Date.now()}`,
			metadata: { type: "mc_report", importance: "medium" },
		};
		appendEvent(db, targetAgentId, JSON.stringify(reportEvent));

		// Discord 側: report を消費
		const reports = consumeEvents(db, targetAgentId);
		expect(reports).toHaveLength(1);
		const reportParsed = JSON.parse(reports.at(0)?.payload ?? "{}");
		expect(reportParsed.content).toBe("木を5本伐採した");
	});

	test("session lock の取得→解放フロー", () => {
		const db = createTestDb();
		const guildId = "test-guild-123";

		// ロック取得
		const lock = tryAcquireSessionLock(db, guildId);
		expect(lock).toEqual({ ok: true });

		// guildId が取得できる
		expect(getSessionLockGuildId(db)).toBe(guildId);

		// ロック解放
		const released = releaseSessionLock(db, guildId);
		expect(released).toBe(true);

		// 別の guild が取得可能に
		const reacquire = tryAcquireSessionLock(db, "other-guild");
		expect(reacquire).toEqual({ ok: true });
	});

	test("コマンド順序保持: 複数コマンドが id 昇順で返る", () => {
		const db = createTestDb();

		appendEvent(db, "minecraft:brain", JSON.stringify({ content: "first" }));
		appendEvent(db, "minecraft:brain", JSON.stringify({ content: "second" }));
		appendEvent(db, "minecraft:brain", JSON.stringify({ content: "third" }));

		const events = consumeEvents(db, "minecraft:brain");
		expect(events).toHaveLength(3);

		const contents = events.map((e) => (JSON.parse(e.payload) as { content: string }).content);
		expect(contents).toEqual(["first", "second", "third"]);

		// id が昇順であることを確認
		const id0 = events[0]?.id ?? 0;
		const id1 = events[1]?.id ?? 0;
		const id2 = events[2]?.id ?? 0;
		expect(id0).toBeLessThan(id1);
		expect(id1).toBeLessThan(id2);
	});

	test("agentId の独立性: 異なる agentId の消費が互いに影響しない", () => {
		const db = createTestDb();

		appendEvent(db, "minecraft:brain", JSON.stringify({ content: "minecraft向け" }));
		appendEvent(db, "discord:guild-1", JSON.stringify({ content: "discord向け" }));

		// minecraft だけ消費
		const mcEvents = consumeEvents(db, "minecraft:brain");
		expect(mcEvents).toHaveLength(1);

		// discord は未消費のまま
		const discordEvents = consumeEvents(db, "discord:guild-1");
		expect(discordEvents).toHaveLength(1);
		const parsed = JSON.parse(discordEvents.at(0)?.payload ?? "{}");
		expect(parsed.content).toBe("discord向け");
	});
});

describe("check_commands データアクセス層テスト", () => {
	test("check_commands: イベントがない場合に空配列を返す", () => {
		const db = createTestDb();

		const events = consumeEvents(db, MINECRAFT_AGENT_ID, MAX_BATCH_SIZE);

		expect(events).toEqual([]);
	});

	test("check_commands: イベントがある場合にイベントを消費して返す", () => {
		const db = createTestDb();
		const command = {
			ts: new Date().toISOString(),
			content: "ダイヤモンドを掘って",
			authorId: "discord",
			authorName: "Discord Agent",
			messageId: `cmd-${Date.now()}`,
			metadata: { type: "command" },
		};
		appendEvent(db, MINECRAFT_AGENT_ID, JSON.stringify(command));

		const events = consumeEvents(db, MINECRAFT_AGENT_ID, MAX_BATCH_SIZE);

		expect(events).toHaveLength(1);
		const parsed = JSON.parse(events.at(0)?.payload ?? "{}");
		expect(parsed.content).toBe("ダイヤモンドを掘って");
		expect(parsed.authorId).toBe("discord");
	});

	test("check_commands: 消費後にイベントが削除される", () => {
		const db = createTestDb();
		appendEvent(db, MINECRAFT_AGENT_ID, JSON.stringify({ content: "最初のコマンド" }));
		appendEvent(db, MINECRAFT_AGENT_ID, JSON.stringify({ content: "次のコマンド" }));

		// 1回目の消費でイベントを取得
		const firstBatch = consumeEvents(db, MINECRAFT_AGENT_ID, MAX_BATCH_SIZE);
		expect(firstBatch).toHaveLength(2);

		// 2回目の消費では空配列が返る
		const secondBatch = consumeEvents(db, MINECRAFT_AGENT_ID, MAX_BATCH_SIZE);
		expect(secondBatch).toEqual([]);
	});
});

describe("check_commands ツール結合テスト", () => {
	test("イベントがない場合、返却テキストが「新しい指示はありません」である", () => {
		const db = createTestDb();

		// registerMinecraftBridgeTools が登録するハンドラをキャプチャする
		type ToolHandler = () => { content: { type: string; text: string }[] };
		const handlers = new Map<string, ToolHandler>();
		const mockServer = {
			registerTool: (name: string, _schema: unknown, handler: ToolHandler) => {
				handlers.set(name, handler);
			},
		} as unknown as McpServer;

		registerMinecraftBridgeTools(mockServer, { db });

		const checkCommands = handlers.get("check_commands");
		if (!checkCommands) throw new Error("check_commands handler not found");

		const result = checkCommands();
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.text).toBe("新しい指示はありません");
	});
});
