import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type mineflayer from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";

import { type GetBot, textResult } from "./shared.ts";

const MAX_CHAT_LENGTH = 256;

/** 6 方向の隣接オフセット（上, 下, 東, 西, 南, 北） */
const FACE_VECTORS: Vec3[] = [
	new Vec3(0, 1, 0),
	new Vec3(0, -1, 0),
	new Vec3(1, 0, 0),
	new Vec3(-1, 0, 0),
	new Vec3(0, 0, 1),
	new Vec3(0, 0, -1),
];

/** ターゲット座標周囲から隣接固体ブロックを探して設置する */
async function placeOnAdjacentBlock(
	bot: mineflayer.Bot,
	targetPos: Vec3,
	blockName: string,
): Promise<string> {
	const { x, y, z: zCoord } = targetPos;
	for (const face of FACE_VECTORS) {
		const refPos = targetPos.plus(face);
		const refBlock = bot.blockAt(refPos);
		if (refBlock && refBlock.name !== "air" && refBlock.name !== "cave_air") {
			const faceVector = face.scaled(-1);
			// eslint-disable-next-line no-await-in-loop -- 最初に見つかった隣接ブロックで即 return
			await bot.placeBlock(refBlock, faceVector);
			return `${blockName} を (${String(x)}, ${String(y)}, ${String(zCoord)}) に設置しました`;
		}
	}
	return `(${String(x)}, ${String(y)}, ${String(zCoord)}) の周囲に隣接ブロックが見つかりません`;
}

export function registerSendChat(server: McpServer, getBot: GetBot): void {
	server.tool(
		"send_chat",
		"Minecraft ゲーム内チャットにメッセージを送信する（コマンド送信不可）",
		{
			message: z
				.string()
				.min(1)
				.max(MAX_CHAT_LENGTH)
				.describe(`送信するメッセージ（最大 ${String(MAX_CHAT_LENGTH)} 文字、"/" 始まり禁止）`),
		},
		({ message }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");
			if (message.startsWith("/")) return textResult("コマンド送信は許可されていません");
			bot.chat(message);
			return textResult(`チャット送信: "${message}"`);
		},
	);
}

export function registerEquipItem(server: McpServer, getBot: GetBot): void {
	server.tool(
		"equip_item",
		"インベントリのアイテムを装備する",
		{
			itemName: z.string().describe('アイテム名（例: "diamond_sword", "iron_helmet"）'),
			destination: z
				.enum(["hand", "head", "torso", "legs", "feet", "off-hand"])
				.default("hand")
				.describe("装備先（デフォルト: hand）"),
		},
		async ({ itemName, destination }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const item = bot.inventory.items().find((i) => i.name === itemName);
			if (!item) return textResult(`インベントリに "${itemName}" がありません`);

			await bot.equip(item, destination);
			return textResult(`${itemName} を ${destination} に装備しました`);
		},
	);
}

export function registerPlaceBlock(server: McpServer, getBot: GetBot): void {
	server.tool(
		"place_block",
		"指定座標にブロックを設置する（インベントリからアイテムを自動装備）",
		{
			blockName: z
				.string()
				.describe('設置するブロックのアイテム名（例: "cobblestone", "oak_planks"）'),
			x: z.number().int().describe("設置先の X 座標"),
			y: z.number().int().describe("設置先の Y 座標"),
			z: z.number().int().describe("設置先の Z 座標"),
		},
		async ({ blockName, x, y, z: zCoord }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const item = bot.inventory.items().find((i) => i.name === blockName);
			if (!item) return textResult(`インベントリに "${blockName}" がありません`);

			await bot.equip(item, "hand");

			const targetPos = new Vec3(x, y, zCoord);
			const targetBlock = bot.blockAt(targetPos);
			if (targetBlock && targetBlock.name !== "air" && targetBlock.name !== "cave_air") {
				return textResult(
					`(${String(x)}, ${String(y)}, ${String(zCoord)}) は ${targetBlock.name} で埋まっています`,
				);
			}

			const result = await placeOnAdjacentBlock(bot, targetPos, blockName);
			return textResult(result);
		},
	);
}
