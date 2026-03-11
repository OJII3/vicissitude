import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

import type { Importance } from "./helpers.ts";

export function shouldWakeMinecraftBrain(kind: string, importance: Importance, description: string): boolean {
	if (importance === "high" || importance === "critical") return true;
	if (kind === "damage") return true;
	if (kind === "health" && importance === "medium") return true;
	if (kind === "job" && description.startsWith("ジョブ失敗:")) return true;
	return false;
}

export function createMinecraftBrainWakeNotifier(signalPath: string): (stamp?: string) => void {
	return (stamp?: string) => {
		mkdirSync(dirname(signalPath), { recursive: true });
		writeFileSync(signalPath, stamp ?? new Date().toISOString(), "utf8");
	};
}
