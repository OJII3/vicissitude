import type mineflayer from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";

const DIRECT_AWARENESS_DISTANCE = 4;
const DEFAULT_BLOCK_CANDIDATE_COUNT = 24;
const BOT_EYE_HEIGHT = 1.62;
type VisibleBlock = NonNullable<ReturnType<mineflayer.Bot["blockAt"]>>;

function distanceToBot(bot: mineflayer.Bot, position: Vec3): number {
	return position.distanceTo(bot.entity.position);
}

function isImmediatelyPerceivable(bot: mineflayer.Bot, position: Vec3): boolean {
	return distanceToBot(bot, position) <= DIRECT_AWARENESS_DISTANCE;
}

function isOccludingBlock(block: { boundingBox?: string }): boolean {
	return block.boundingBox === "block";
}

export async function canPerceiveEntity(bot: mineflayer.Bot, entity: Entity): Promise<boolean> {
	if (!bot.entity || !entity.position) return false;
	if (isImmediatelyPerceivable(bot, entity.position)) return true;

	const eyePosition = bot.entity.position.offset(0, BOT_EYE_HEIGHT, 0);
	const targetHeight = Math.max(0.9, Math.min(entity.height ?? 1.6, 1.6));
	const targetPosition = entity.position.offset(0, targetHeight, 0);
	const direction = targetPosition.minus(eyePosition);
	const range = direction.norm();
	if (range <= 0) return true;

	const blocker = await bot.world.raycast(
		eyePosition,
		direction.normalize(),
		range,
		isOccludingBlock,
	);
	return blocker === null;
}

export async function findPerceivedEntityByName(
	bot: mineflayer.Bot,
	name: string,
	maxDistance = 32,
): Promise<Entity | null> {
	const lowerName = name.toLowerCase();
	const matches = Object.values(bot.entities)
		.filter(
			(entity) =>
				entity !== bot.entity &&
				entity.position &&
				entity.name?.toLowerCase() === lowerName &&
				distanceToBot(bot, entity.position) <= maxDistance,
		)
		.toSorted(
			(left, right) => distanceToBot(bot, left.position) - distanceToBot(bot, right.position),
		);

	for (const entity of matches) {
		// oxlint-disable-next-line no-await-in-loop -- 近い順に最初に知覚できる対象を採用する
		if (await canPerceiveEntity(bot, entity)) return entity;
	}

	return null;
}

export function canPerceiveBlock(bot: mineflayer.Bot, block: VisibleBlock): boolean {
	if (!bot.entity) return false;
	if (isImmediatelyPerceivable(bot, block.position)) return true;
	return bot.canSeeBlock(block);
}

export function findPerceivedBlock(
	bot: mineflayer.Bot,
	options: Parameters<mineflayer.Bot["findBlocks"]>[0] & { count?: number },
): VisibleBlock | null {
	const positions = bot.findBlocks({
		...options,
		count: options.count ?? DEFAULT_BLOCK_CANDIDATE_COUNT,
	});

	for (const position of positions) {
		const block = bot.blockAt(position);
		if (!block) continue;
		if (canPerceiveBlock(bot, block)) return block;
	}

	return null;
}

// helpers.ts の名前を mcp-tools.ts / bot-connection.ts 向けに re-export
export { IMPORTANCE_ORDER, getTimePeriod } from "./helpers.ts";
export type { ActionState, Importance } from "./helpers.ts";

export function getWeather(b: mineflayer.Bot): string {
	if (b.thunderState > 0) return "雷雨";
	if (b.isRaining) return "雨";
	return "晴れ";
}

export async function getNearbyEntities(
	b: mineflayer.Bot,
	limit: number,
): Promise<{ name: string; distance: number; type: string }[]> {
	const nearby = Object.values(b.entities)
		.filter((e) => e !== b.entity && e.position)
		.toSorted((left, right) => distanceToBot(b, left.position) - distanceToBot(b, right.position));

	const visible: { name: string; distance: number; type: string }[] = [];
	for (const entity of nearby) {
		// oxlint-disable-next-line no-await-in-loop -- 近い順に limit 件だけ集めたい
		if (!(await canPerceiveEntity(b, entity))) continue;
		visible.push({
			name: entity.username ?? entity.displayName ?? entity.name ?? "unknown",
			distance: Math.round(distanceToBot(b, entity.position)),
			type: entity.type,
		});
		if (visible.length >= limit) break;
	}

	return visible;
}

export function getInventorySummary(b: mineflayer.Bot): {
	items: { name: string; count: number }[];
	emptySlots: number;
} {
	const rawItems = b.inventory.items();
	const items = rawItems.map((item) => ({
		name: item.displayName ?? item.name,
		count: item.count,
	}));
	const totalSlots = b.inventory.slots.length;
	return { items, emptySlots: totalSlots - rawItems.length };
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

const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

export function getNearbyBlockCounts(
	bot: mineflayer.Bot,
	maxDistance: number,
): Map<string, number> {
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

	// カウント降順ソート
	return new Map([...counts.entries()].toSorted((a, b) => b[1] - a[1]));
}
