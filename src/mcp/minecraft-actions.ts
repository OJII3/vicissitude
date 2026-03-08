import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { Movements, goals } from "mineflayer-pathfinder";
import { z } from "zod";

type GetBot = () => mineflayer.Bot | null;
type Importance = "low" | "medium" | "high";
type PushEvent = (kind: string, description: string, importance: Importance) => void;
interface ActionState {
	type: "idle" | "following" | "moving" | "collecting";
	target?: string;
}
type SetActionState = (state: ActionState) => void;
type TextResult = { content: { type: "text"; text: string }[] };

const MAX_COLLECT_COUNT = 64;

function textResult(text: string): TextResult {
	return { content: [{ type: "text", text }] };
}

function ensureMovements(b: mineflayer.Bot): void {
	if (!b.pathfinder.movements) {
		b.pathfinder.setMovements(new Movements(b));
	}
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

	// 移動後にブロックがまだ存在するか再検証
	const current = b.blockAt(block.position);
	if (!current || current.type !== blockId) return false;

	const tool = b.pathfinder.bestHarvestTool(current);
	if (tool) await b.equip(tool, "hand");
	await b.dig(current);
	return true;
}

async function collectBlocks(
	b: mineflayer.Bot,
	blockId: number,
	maxDistance: number,
	count: number,
): Promise<number> {
	let collected = 0;
	while (collected < count) {
		// eslint-disable-next-line no-await-in-loop -- ブロック採掘は順次実行が必須
		const dug = await digOneBlock(b, blockId, maxDistance);
		if (!dug) break;
		collected++;
	}
	return collected;
}

function registerFollowPlayer(
	server: McpServer,
	getBot: GetBot,
	pushEvent: PushEvent,
	setActionState: SetActionState,
): void {
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

			ensureMovements(bot);
			bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);

			setActionState({ type: "following", target: username });

			// 対象プレイヤーがログアウトしたら自動停止
			const onPlayerLeft = (player: { username: string }) => {
				if (player.username === username) {
					bot.pathfinder.stop();
					setActionState({ type: "idle" });
					pushEvent("follow", `${username} がログアウトしたため追従を停止`, "medium");
				}
			};
			bot.once("playerLeft", onPlayerLeft);

			pushEvent("follow", `${username} への追従を開始（range: ${String(range)}）`, "medium");
			return textResult(`${username} への追従を開始しました（range: ${String(range)}）`);
		},
	);
}

function registerGoTo(
	server: McpServer,
	getBot: GetBot,
	pushEvent: PushEvent,
	setActionState: SetActionState,
): void {
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

			ensureMovements(bot);
			const coord = `(${String(x)}, ${String(y)}, ${String(zCoord)})`;
			setActionState({ type: "moving", target: coord });
			try {
				await bot.pathfinder.goto(new goals.GoalNear(x, y, zCoord, range));
				setActionState({ type: "idle" });
				pushEvent("navigation", `${coord} に到達`, "medium");
				return textResult(`${coord} に到達しました`);
			} catch (err) {
				setActionState({ type: "idle" });
				const msg = err instanceof Error ? err.message : String(err);
				pushEvent("navigation", `${coord} への移動に失敗: ${msg}`, "medium");
				return textResult(`移動に失敗しました: ${msg}`);
			}
		},
	);
}

function registerCollectBlock(
	server: McpServer,
	getBot: GetBot,
	pushEvent: PushEvent,
	setActionState: SetActionState,
): void {
	server.tool(
		"collect_block",
		"指定ブロックを探して採集する（最適ツールを自動装備）",
		{
			blockName: z.string().describe('ブロック名（例: "oak_log", "diamond_ore"）'),
			count: z
				.number()
				.int()
				.min(1)
				.max(MAX_COLLECT_COUNT)
				.default(1)
				.describe(`採集する個数（デフォルト: 1、最大: ${String(MAX_COLLECT_COUNT)}）`),
			maxDistance: z.number().min(1).default(32).describe("検索範囲（デフォルト: 32）"),
		},
		async ({ blockName, count, maxDistance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const blockType = bot.registry.blocksByName[blockName];
			if (!blockType) return textResult(`不明なブロック名: "${blockName}"`);

			ensureMovements(bot);
			setActionState({ type: "collecting", target: blockName });
			try {
				const collected = await collectBlocks(bot, blockType.id, maxDistance, count);
				setActionState({ type: "idle" });
				const progress = `${String(collected)}/${String(count)}`;
				pushEvent("collect", `${blockName} を ${progress} 個採集`, "low");
				return textResult(`${blockName} を ${progress} 個採集しました`);
			} catch (err) {
				setActionState({ type: "idle" });
				const msg = err instanceof Error ? err.message : String(err);
				pushEvent("collect", `${blockName} の採集中にエラー: ${msg}`, "low");
				return textResult(`${blockName} の採集中にエラー: ${msg}`);
			}
		},
	);
}

function registerStop(
	server: McpServer,
	getBot: GetBot,
	pushEvent: PushEvent,
	setActionState: SetActionState,
): void {
	server.tool("stop", "現在の移動・追従を停止する", {}, () => {
		const bot = getBot();
		if (!bot?.entity) return textResult("ボット未接続");

		bot.pathfinder.stop();
		setActionState({ type: "idle" });
		pushEvent("stop", "移動を停止", "low");
		return textResult("移動を停止しました");
	});
}

export function registerActionTools(
	server: McpServer,
	getBot: GetBot,
	pushEvent: PushEvent,
	setActionState: SetActionState,
): void {
	registerFollowPlayer(server, getBot, pushEvent, setActionState);
	registerGoTo(server, getBot, pushEvent, setActionState);
	registerCollectBlock(server, getBot, pushEvent, setActionState);
	registerStop(server, getBot, pushEvent, setActionState);
}
