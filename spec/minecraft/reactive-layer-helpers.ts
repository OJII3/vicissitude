import { mock } from "bun:test";
import { EventEmitter } from "events";

import type { BotContext, BotEvent } from "@vicissitude/minecraft/bot-context";
import type { ActionState } from "@vicissitude/minecraft/helpers";

// ---------------------------------------------------------------------------
// BotContext スタブ
// ---------------------------------------------------------------------------

export function createStubContext(): BotContext & { events: BotEvent[] } {
	const events: BotEvent[] = [];
	let bot: unknown = null;
	const actionState: ActionState = { type: "idle" };

	return {
		events,
		getBot: () => bot as ReturnType<BotContext["getBot"]>,
		setBot: (b) => {
			bot = b;
		},
		getEvents: () => events,
		pushEvent: (kind, description, importance) => {
			events.push({
				timestamp: new Date().toISOString(),
				kind,
				description,
				importance,
			});
		},
		getActionState: () => actionState,
		setActionState: (state) => {
			Object.assign(actionState, state);
		},
	};
}

// ---------------------------------------------------------------------------
// fakeBot ファクトリ
// ---------------------------------------------------------------------------

export interface FakeFoodInfo {
	name: string;
	foodPoints: number;
	effectiveQuality: number;
	saturation: number;
}

export function createFakeBot(overrides?: {
	health?: number;
	food?: number;
	entities?: Record<string, unknown>;
	inventoryItems?: { name: string; count: number }[];
	foodsByName?: Record<string, FakeFoodInfo>;
}) {
	const inventoryItems = overrides?.inventoryItems ?? [];
	const foodsByName = overrides?.foodsByName ?? {};

	// oxlint-disable-next-line prefer-event-target -- mineflayer.Bot は EventEmitter ベース
	const bot = new EventEmitter() as EventEmitter & {
		username: string;
		entity: { position: { x: number; y: number; z: number } };
		health: number;
		food: number;
		time: { timeOfDay: number };
		entities: Record<string, unknown>;
		inventory: {
			items: () => { name: string; count: number; displayName?: string }[];
			slots: unknown[];
		};
		registry: { foodsByName: Record<string, FakeFoodInfo> };
		quit: ReturnType<typeof mock>;
		respawn: ReturnType<typeof mock>;
		equip: ReturnType<typeof mock>;
		consume: ReturnType<typeof mock>;
		setControlState: ReturnType<typeof mock>;
		look: ReturnType<typeof mock>;
		clearControlStates: ReturnType<typeof mock>;
		pathfinder: { goto: ReturnType<typeof mock> };
	};
	bot.username = "test-bot";
	bot.entity = { position: { x: 0, y: 64, z: 0 } };
	bot.health = overrides?.health ?? 20;
	bot.food = overrides?.food ?? 20;
	bot.time = { timeOfDay: 0 };
	bot.entities = overrides?.entities ?? {};
	bot.inventory = {
		items: () => inventoryItems.map((i) => Object.assign({}, i)),
		slots: [],
	};
	bot.registry = { foodsByName };
	bot.quit = mock(() => {});
	bot.respawn = mock(() => {});
	bot.equip = mock(() => Promise.resolve());
	bot.consume = mock(() => Promise.resolve());
	bot.setControlState = mock(() => {});
	bot.look = mock(() => {});
	bot.clearControlStates = mock(() => {});
	bot.pathfinder = { goto: mock(() => Promise.resolve()) };
	return bot;
}

// ---------------------------------------------------------------------------
// hostile mob エンティティのヘルパー
// ---------------------------------------------------------------------------

export const DEFAULT_BOT_POSITION = { x: 0, y: 64, z: 0 };

export function createHostileEntity(
	name: string,
	distance: number,
	botPosition: { x: number; y: number; z: number } = DEFAULT_BOT_POSITION,
) {
	return {
		name,
		type: "mob",
		position: {
			x: botPosition.x + distance,
			y: botPosition.y,
			z: botPosition.z,
			distanceTo: (other: { x: number; y: number; z: number }) => {
				const dx = botPosition.x + distance - other.x;
				const dy = botPosition.y - other.y;
				const dz = botPosition.z - other.z;
				return Math.sqrt(dx * dx + dy * dy + dz * dz);
			},
		},
		username: undefined,
		displayName: name,
		height: 1.8,
	};
}
