import type mineflayer from "mineflayer";
import pathfinderPkg, { type goals as GoalsNamespace } from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";

import type { JobExecutor, JobManager } from "../job-manager.ts";

const { Movements } = pathfinderPkg;

export type GetBot = () => mineflayer.Bot | null;
export type TextResult = { content: { type: "text"; text: string }[] };

export function textResult(text: string): TextResult {
	return { content: [{ type: "text", text }] };
}

/**
 * bot 未接続ガードの高階ラッパ。
 *
 * `getBot()` が `null`、または `bot.entity` を持たない場合は接続前とみなし、
 * `textResult("ボット未接続")` を返す。接続済みの場合のみ `handler` を呼び出す。
 *
 * 各 registerTool の callback を `withConnectedBot(getBot, async (bot, args) => {...})`
 * の形へ置換するために使う。args は MCP SDK が callback へ渡す入力をそのまま受け渡す。
 */
export function withConnectedBot<Args>(
	getBot: GetBot,
	handler: (bot: mineflayer.Bot, args: Args) => TextResult | Promise<TextResult>,
): (args: Args) => TextResult | Promise<TextResult> {
	return (args: Args) => {
		const bot = getBot();
		if (!bot?.entity) return textResult("ボット未接続");
		return handler(bot, args);
	};
}

/**
 * 逃走ゴール（対象から離れる pathfinder ゴール）を構築する。
 *
 * `GoalFollow`（対象へ近づくゴール）を `GoalInvert` で反転させることで
 * 「対象から `distance` ブロック分離れる」挙動になる。
 * `actions/survival/escape.ts` と `reactive-layer.ts` の双方で共有する。
 */
export function createFleeGoal(target: Entity, distance: number): GoalsNamespace.Goal {
	const { goals } = pathfinderPkg;
	return new goals.GoalInvert(new goals.GoalFollow(target, distance));
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
