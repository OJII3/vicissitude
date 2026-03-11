import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

import type { Importance } from "./helpers.ts";

let wakeSequence = 0;

export function shouldWakeMinecraftBrain(
	kind: string,
	importance: Importance,
	description: string,
): boolean {
	if (importance === "high" || importance === "critical") return true;
	if (kind === "damage") return true;
	if (kind === "health" && importance === "medium") return true;
	if (kind === "job" && description.startsWith("ジョブ失敗:")) return true;
	return false;
}

export function createMinecraftBrainWakeNotifier(signalPath: string): (stamp?: string) => void {
	return (stamp?: string) => {
		mkdirSync(dirname(signalPath), { recursive: true });
		wakeSequence += 1;
		writeFileSync(signalPath, stamp ?? `${String(Date.now())}:${String(wakeSequence)}`, "utf8");
	};
}
