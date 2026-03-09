import type mineflayer from "mineflayer";

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

export function createBotContext(): BotContext {
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
