import type mineflayer from "mineflayer";
import { Movements } from "mineflayer-pathfinder";

export type GetBot = () => mineflayer.Bot | null;
export type TextResult = { content: { type: "text"; text: string }[] };

export function textResult(text: string): TextResult {
	return { content: [{ type: "text", text }] };
}

export function ensureMovements(b: mineflayer.Bot): void {
	if (!b.pathfinder.movements) {
		b.pathfinder.setMovements(new Movements(b));
	}
}

export function registerAbortHandler(bot: mineflayer.Bot, signal: AbortSignal): void {
	signal.addEventListener(
		"abort",
		() => {
			bot.pathfinder.stop();
		},
		{ once: true },
	);
}
