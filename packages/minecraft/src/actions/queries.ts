import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Vec3 } from "vec3";
import { z } from "zod";

import { type GetBot, textResult } from "./shared.ts";

const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
const MAX_NEARBY_DISTANCE = 32;

export function registerNearbyBlocks(server: McpServer, getBot: GetBot): void {
	server.registerTool(
		"nearby_blocks",
		{
			description: "周辺ブロックの種類と数を返す",
			inputSchema: {
				maxDistance: z
					.number()
					.min(1)
					.max(MAX_NEARBY_DISTANCE)
					.default(16)
					.describe("探索範囲（デフォルト: 16、最大: 32）"),
			},
		},
		({ maxDistance }) => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const pos = bot.entity.position;
			const cx = Math.floor(pos.x);
			const cy = Math.floor(pos.y);
			const cz = Math.floor(pos.z);
			const counts = new Map<string, number>();
			const yRange = Math.min(maxDistance, 8);

			for (let dx = -maxDistance; dx <= maxDistance; dx += 2) {
				for (let dz = -maxDistance; dz <= maxDistance; dz += 2) {
					for (let dy = -yRange; dy <= yRange; dy += 2) {
						const block = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
						if (!block || AIR_BLOCKS.has(block.name)) continue;
						counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
					}
				}
			}

			if (counts.size === 0) return textResult("周辺にブロックが見つかりません");

			const sorted = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
			const lines = sorted.map(([name, count]) => `${name}: ${String(count)}`);
			return textResult(lines.join("\n"));
		},
	);
}

export function registerCraftableItems(server: McpServer, getBot: GetBot): void {
	server.registerTool(
		"craftable_items",
		{ description: "現在のインベントリでクラフト可能なアイテム一覧を返す" },
		() => {
			const bot = getBot();
			if (!bot?.entity) return textResult("ボット未接続");

			const craftable: { name: string; needsTable: boolean }[] = [];
			for (const item of bot.registry.itemsArray) {
				const withoutTable = bot.recipesFor(item.id, null, null, false);
				if (withoutTable.length > 0) {
					craftable.push({ name: item.displayName ?? item.name, needsTable: false });
					continue;
				}
				const withTable = bot.recipesFor(item.id, null, null, true);
				if (withTable.length > 0) {
					craftable.push({ name: item.displayName ?? item.name, needsTable: true });
				}
			}

			if (craftable.length === 0) return textResult("クラフト可能なアイテムはありません");

			const lines = craftable.map((c) => (c.needsTable ? `${c.name} (要作業台)` : c.name));
			return textResult(`クラフト可能: ${lines.join(", ")}`);
		},
	);
}

export function registerGetBiome(server: McpServer, getBot: GetBot): void {
	server.registerTool("get_biome", { description: "現在のバイオーム名を返す" }, () => {
		const bot = getBot();
		if (!bot?.entity) return textResult("ボット未接続");

		const pos = bot.entity.position;
		const biomeId = bot.world.getBiome(pos);
		const biome = bot.registry.biomes?.[biomeId];
		return textResult(biome?.name ?? `不明なバイオーム (ID: ${String(biomeId)})`);
	});
}
