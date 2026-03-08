import type mineflayer from "mineflayer";

export function getWeather(b: mineflayer.Bot): string {
	if (b.thunderState > 0) return "雷雨";
	if (b.isRaining) return "雨";
	return "晴れ";
}

export function getNearbyEntities(
	b: mineflayer.Bot,
	limit: number,
): { name: string; distance: number; type: string }[] {
	return Object.values(b.entities)
		.filter((e) => e !== b.entity && e.position)
		.map((e) => ({
			name: e.username ?? e.displayName ?? e.name ?? "unknown",
			distance: Math.round(e.position.distanceTo(b.entity.position)),
			type: e.type,
		}))
		.toSorted((x, y) => x.distance - y.distance)
		.slice(0, limit);
}

export function getInventorySummary(b: mineflayer.Bot): {
	items: { name: string; count: number }[];
	emptySlots: number;
} {
	const items = b.inventory
		.items()
		.map((item) => ({ name: item.displayName ?? item.name, count: item.count }));
	const totalSlots = b.inventory.slots.length;
	const usedSlots = b.inventory.items().length;
	return { items, emptySlots: totalSlots - usedSlots };
}

export function getEquipment(b: mineflayer.Bot): Record<string, string> {
	const result: Record<string, string> = {};
	const slots: [string, number][] = [
		["head", 5],
		["chest", 6],
		["legs", 7],
		["feet", 8],
		["offhand", 45],
	];
	for (const [name, idx] of slots) {
		const item = b.inventory.slots[idx];
		if (item) result[name] = item.displayName ?? item.name;
	}
	const hand = b.heldItem;
	if (hand) result.hand = hand.displayName ?? hand.name;
	return result;
}
