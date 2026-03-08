import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { Movements, goals } from "mineflayer-pathfinder";
import { z } from "zod";

type GetBot = () => mineflayer.Bot | null;
type PushEvent = (kind: string, description: string) => void;
type TextResult = { content: { type: "text"; text: string }[] };

function textResult(text: string): TextResult {
	return { content: [{ type: "text", text }] };
}

async function digOneBlock(
	b: mineflayer.Bot,
	blockId: number,
	maxDistance: number,
): Promise<boolean> {
	const block = b.findBlock({ matching: blockId, maxDistance });
	if (!block) return false;
	const { x, y, z: bz } = block.position;
	await b.pathfinder.goto(new goals.GoalGetToBlock(x, y, bz));
	await b.dig(block);
	return true;
}

async function collectBlocks(
	b: mineflayer.Bot,
	blockId: number,
	maxDistance: number,
	remaining: number,
): Promise<number> {
	if (remaining <= 0) return 0;
	const dug = await digOneBlock(b, blockId, maxDistance);
	if (!dug) return 0;
	return 1 + (await collectBlocks(b, blockId, maxDistance, remaining - 1));
}

function registerFollowPlayer(server: McpServer, getBot: GetBot, pushEvent: PushEvent): void {
	server.tool(
		"follow_player",
		"指定プレイヤーへの追従を開始する",
		{
			username: z.string().describe("追従対象のプレイヤー名"),
			range: z.number().min(1).default(3).describe("何ブロック以内に接近するか（デフォルト: 3）"),
		},
		({ username, range }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const entity = bot.players[username]?.entity;
			if (!entity) {
				return textResult(`プレイヤー "${username}" が見つからないか、視界内にいません`);
			}

			bot.pathfinder.setMovements(new Movements(bot));
			bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);
			pushEvent("follow", `${username} への追従を開始（range: ${String(range)}）`);
			return textResult(`${username} への追従を開始しました（range: ${String(range)}）`);
		},
	);
}

function registerGoTo(server: McpServer, getBot: GetBot, pushEvent: PushEvent): void {
	server.tool(
		"go_to",
		"指定座標への移動を実行する",
		{
			x: z.number().describe("X 座標"),
			y: z.number().describe("Y 座標"),
			z: z.number().describe("Z 座標"),
			range: z.number().min(0).default(2).describe("目標地点からの許容距離（デフォルト: 2）"),
		},
		async ({ x, y, z: zCoord, range }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			bot.pathfinder.setMovements(new Movements(bot));
			const coord = `(${String(x)}, ${String(y)}, ${String(zCoord)})`;
			try {
				await bot.pathfinder.goto(new goals.GoalNear(x, y, zCoord, range));
				pushEvent("navigation", `${coord} に到達`);
				return textResult(`${coord} に到達しました`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				pushEvent("navigation", `${coord} への移動に失敗: ${msg}`);
				return textResult(`移動に失敗しました: ${msg}`);
			}
		},
	);
}

function registerCollectBlock(server: McpServer, getBot: GetBot, pushEvent: PushEvent): void {
	server.tool(
		"collect_block",
		"指定ブロックを探して採集する",
		{
			blockName: z.string().describe('ブロック名（例: "oak_log", "diamond_ore"）'),
			count: z.number().int().min(1).default(1).describe("採集する個数（デフォルト: 1）"),
			maxDistance: z.number().min(1).default(32).describe("検索範囲（デフォルト: 32）"),
		},
		async ({ blockName, count, maxDistance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const blockType = bot.registry.blocksByName[blockName];
			if (!blockType) return textResult(`不明なブロック名: "${blockName}"`);

			bot.pathfinder.setMovements(new Movements(bot));
			try {
				const collected = await collectBlocks(bot, blockType.id, maxDistance, count);
				const progress = `${String(collected)}/${String(count)}`;
				pushEvent("collect", `${blockName} を ${progress} 個採集`);
				return textResult(`${blockName} を ${progress} 個採集しました`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				pushEvent("collect", `${blockName} の採集中にエラー: ${msg}`);
				return textResult(`${blockName} の採集中にエラー: ${msg}`);
			}
		},
	);
}

function registerStop(server: McpServer, getBot: GetBot, pushEvent: PushEvent): void {
	server.tool("stop", "現在の移動・追従を停止する", {}, () => {
		const bot = getBot();
		if (!bot?.entity) return textResult("ボット未接続");

		bot.pathfinder.stop();
		pushEvent("stop", "移動を停止");
		return textResult("移動を停止しました");
	});
}

export function registerActionTools(server: McpServer, getBot: GetBot, pushEvent: PushEvent): void {
	registerFollowPlayer(server, getBot, pushEvent);
	registerGoTo(server, getBot, pushEvent);
	registerCollectBlock(server, getBot, pushEvent);
	registerStop(server, getBot, pushEvent);
}
