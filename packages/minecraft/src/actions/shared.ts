import type mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

import type { JobExecutor, JobManager } from "../job-manager.ts";

const { Movements } = pathfinderPkg;

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

/** ベッドブロック名の色リスト（16 色） */
// prettier-ignore
const BED_COLORS = [
	"white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
	"light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
];

/** レジストリからベッドブロック ID を全色分収集する */
export function collectBedIds(bot: mineflayer.Bot): number[] {
	const ids: number[] = [];
	for (const color of BED_COLORS) {
		const bed = bot.registry.blocksByName[`${color}_bed`];
		if (bed) ids.push(bed.id);
	}
	return ids;
}

export function tryStartJob(
	jobManager: JobManager,
	type: Parameters<JobManager["startJob"]>[0],
	target: string,
	executor: JobExecutor,
): { ok: true; jobId: string } | { ok: false; result: TextResult } {
	try {
		return { ok: true, jobId: jobManager.startJob(type, target, executor) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, result: textResult(message) };
	}
}
