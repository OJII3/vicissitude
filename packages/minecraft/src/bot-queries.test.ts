import { describe, expect, mock, test } from "bun:test";

import { Vec3 } from "vec3";

import {
	canPerceiveEntity,
	findPerceivedBlock,
	findPerceivedEntityByName,
	getNearbyEntities,
} from "./bot-queries.ts";

function keyOf(position: Vec3): string {
	return `${String(position.x)},${String(position.y)},${String(position.z)}`;
}

function makeBot(options?: {
	blocks?: { position: Vec3; name?: string; boundingBox?: "block" | "empty" }[];
	findBlocks?: Vec3[];
	entities?: Record<
		string,
		{ id: number; name?: string; username?: string; type: string; position: Vec3; height?: number }
	>;
	raycast?: (from: Vec3, direction: Vec3, range: number) => Promise<unknown>;
	canSeeBlock?: (block: { position: Vec3 }) => boolean;
}) {
	const blockMap = new Map(
		(options?.blocks ?? []).map((block) => [
			keyOf(block.position),
			{
				position: block.position,
				name: block.name ?? "stone",
				boundingBox: block.boundingBox ?? "block",
			},
		]),
	);

	return {
		entity: {
			position: new Vec3(0, 64, 0),
			eyeHeight: 1.62,
		},
		entities: options?.entities ?? {},
		world: {
			raycast: options?.raycast ?? (() => Promise.resolve(null)),
		},
		findBlocks: mock((_: unknown) => options?.findBlocks ?? []),
		blockAt: mock((position: Vec3) => blockMap.get(keyOf(position)) ?? null),
		canSeeBlock:
			options?.canSeeBlock ??
			mock((block: { position: Vec3 }) => block.position.equals(new Vec3(10, 64, 0))),
	} as never;
}

describe("findPerceivedBlock", () => {
	test("近いブロックは可視判定なしで採用する", () => {
		const bot = makeBot({
			blocks: [{ position: new Vec3(2, 64, 0) }],
			findBlocks: [new Vec3(2, 64, 0)],
			canSeeBlock: mock(() => false),
		});

		const block = findPerceivedBlock(bot, { matching: 1, maxDistance: 16 });
		expect(block?.position.equals(new Vec3(2, 64, 0))).toBe(true);
	});

	test("遠いブロックは可視な候補だけを返す", () => {
		const bot = makeBot({
			blocks: [{ position: new Vec3(8, 64, 0) }, { position: new Vec3(10, 64, 0) }],
			findBlocks: [new Vec3(8, 64, 0), new Vec3(10, 64, 0)],
			canSeeBlock: mock((block: { position: Vec3 }) => block.position.equals(new Vec3(10, 64, 0))),
		});

		const block = findPerceivedBlock(bot, { matching: 1, maxDistance: 16 });
		expect(block?.position.equals(new Vec3(10, 64, 0))).toBe(true);
	});
});

describe("canPerceiveEntity", () => {
	test("近距離エンティティは遮蔽判定なしで知覚できる", async () => {
		const raycast = mock(() => Promise.resolve(null));
		const bot = makeBot({ raycast });
		const entity = {
			id: 1,
			name: "zombie",
			type: "mob",
			position: new Vec3(3, 64, 0),
			height: 1.95,
		};

		expect(await canPerceiveEntity(bot, entity as never)).toBe(true);
		expect(raycast).not.toHaveBeenCalled();
	});

	test("遠距離エンティティは遮蔽物があれば知覚できない", async () => {
		const bot = makeBot({
			raycast: () => Promise.resolve({ position: new Vec3(4, 64, 0), boundingBox: "block" }),
		});
		const entity = {
			id: 1,
			name: "zombie",
			type: "mob",
			position: new Vec3(8, 64, 0),
			height: 1.95,
		};

		expect(await canPerceiveEntity(bot, entity as never)).toBe(false);
	});
});

describe("findPerceivedEntityByName", () => {
	test("同名候補のうち知覚できる対象を返す", async () => {
		const bot = makeBot({
			entities: {
				hidden: { id: 1, name: "zombie", type: "mob", position: new Vec3(8, 64, 0), height: 1.95 },
				visible: { id: 2, name: "zombie", type: "mob", position: new Vec3(3, 64, 0), height: 1.95 },
			},
			raycast: () => Promise.resolve({ position: new Vec3(4, 64, 0), boundingBox: "block" }),
		});

		const entity = await findPerceivedEntityByName(bot, "zombie");
		expect(entity?.id).toBe(2);
	});
});

describe("getNearbyEntities", () => {
	test("遮蔽された遠距離 entity を周辺一覧から除外する", async () => {
		const bot = makeBot({
			entities: {
				hidden: { id: 1, name: "zombie", type: "mob", position: new Vec3(8, 64, 0), height: 1.95 },
				visible: {
					id: 2,
					username: "ojii3",
					type: "player",
					position: new Vec3(3, 64, 0),
					height: 1.8,
				},
			},
			raycast: (_from, direction) =>
				Promise.resolve(
					direction.x > 0.99 ? { position: new Vec3(4, 64, 0), boundingBox: "block" } : null,
				),
		});

		const nearby = await getNearbyEntities(bot, 5);
		expect(nearby).toEqual([{ name: "ojii3", distance: 3, type: "player" }]);
	});
});
