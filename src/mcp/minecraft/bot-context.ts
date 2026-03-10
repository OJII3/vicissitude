import type mineflayer from "mineflayer";

import { METRIC } from "../../core/constants.ts";
import type { MetricsCollector } from "../../core/types.ts";
import type { ActionState, Importance } from "./helpers.ts";

export interface BotEvent {
	timestamp: string;
	kind: string;
	description: string;
	importance: Importance;
}

const MAX_EVENTS = 100;

export interface BotContext {
	getBot(): mineflayer.Bot | null;
	setBot(bot: mineflayer.Bot | null): void;
	getEvents(): BotEvent[];
	pushEvent(kind: string, description: string, importance: Importance): void;
	getActionState(): ActionState;
	setActionState(state: ActionState): void;
}

const BOT_EVENT_KINDS = new Set(["spawn", "death", "kicked", "disconnect"]);

export function createBotContext(metrics?: MetricsCollector): BotContext {
	let bot: mineflayer.Bot | null = null;
	const events: BotEvent[] = [];
	const actionState: ActionState = { type: "idle" };

	return {
		getBot: () => bot,
		setBot: (b) => {
			bot = b;
		},
		getEvents: () => events,
		pushEvent: (kind, description, importance) => {
			events.push({ timestamp: new Date().toISOString(), kind, description, importance });
			if (events.length > MAX_EVENTS) events.shift();
			if (metrics && BOT_EVENT_KINDS.has(kind)) {
				metrics.incrementCounter(METRIC.MC_BOT_EVENTS, { kind });
			}
		},
		getActionState: () => actionState,
		setActionState: (state) => {
			actionState.type = state.type;
			actionState.target = state.target;
			actionState.jobId = state.jobId;
			actionState.progress = state.progress;
		},
	};
}
