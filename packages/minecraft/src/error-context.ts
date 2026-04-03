import type mineflayer from "mineflayer";

import { getNearbyBlockCounts } from "./bot-queries.ts";
import { getOreHint } from "./helpers.ts";

/** ベッド素材となりうるブロック名のパターン（wool, planks） */
const BED_MATERIAL_PATTERN = /wool|planks/i;

/** 採集失敗時のコンテキスト文字列を生成する（3行以内） */
export function buildCollectBlockContext(bot: mineflayer.Bot, blockName: string): string {
	const pos = bot.entity.position;
	const y = Math.floor(pos.y);
	const biomeId = bot.world.getBiome(pos);
	const biome = bot.registry.biomes?.[biomeId];
	const biomeName = biome?.name ?? `biome:${String(biomeId)}`;

	const counts = getNearbyBlockCounts(bot, 16);
	const top5 = [...counts.entries()].slice(0, 5);
	const nearbyText =
		top5.length > 0 ? top5.map(([name, count]) => `${name}x${String(count)}`).join(", ") : "なし";

	const oreHint = getOreHint(blockName);

	const lines: string[] = [
		`バイオーム: ${biomeName} / Y: ${String(y)}`,
		`周辺ブロック: ${nearbyText}`,
	];
	if (oreHint) lines.push(oreHint);

	return lines.join("\n");
}

/** クラフト失敗時のコンテキスト文字列を生成する（3行以内） */
export function buildCraftItemContext(bot: mineflayer.Bot, _itemName: string): string {
	const rawItems = bot.inventory.items();
	const itemText =
		rawItems.length > 0
			? rawItems.map((item) => `${item.name}x${String(item.count)}`).join(", ")
			: "なし";
	return `インベントリ: ${itemText}`;
}

/** 就寝失敗時のコンテキスト文字列を生成する（3行以内） */
export function buildSleepContext(bot: mineflayer.Bot): string {
	const counts = getNearbyBlockCounts(bot, 16);
	const top5 = [...counts.entries()].slice(0, 5);
	const nearbyText =
		top5.length > 0 ? top5.map(([name, count]) => `${name}x${String(count)}`).join(", ") : "なし";

	const hasBedMaterial = [...counts.keys()].some((name) => BED_MATERIAL_PATTERN.test(name));
	const bedInfo = hasBedMaterial ? "ベッド素材（wool/planks）あり" : "ベッド素材なし";

	return [`周辺ブロック: ${nearbyText}`, bedInfo].join("\n");
}

/** 移動失敗時のコンテキスト文字列を生成する（3行以内） */
export function buildGoToContext(
	bot: mineflayer.Bot,
	targetPos: { x: number; y: number; z: number },
): string {
	const pos = bot.entity.position;
	const cx = Math.floor(pos.x);
	const cy = Math.floor(pos.y);
	const cz = Math.floor(pos.z);

	const dx = targetPos.x - pos.x;
	const dy = targetPos.y - pos.y;
	const dz = targetPos.z - pos.z;
	const distance = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));

	return [
		`現在位置: (${String(cx)}, ${String(cy)}, ${String(cz)})`,
		`目標: (${String(targetPos.x)}, ${String(targetPos.y)}, ${String(targetPos.z)}) / 距離: ${String(distance)}m`,
	].join("\n");
}
