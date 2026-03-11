import { readFileSync } from "fs";

import type { BufferedEvent, EventBuffer } from "../core/types.ts";

const DEFAULT_WAKE_POLL_MS = 250;

function readWakeStamp(path: string | undefined): string | null {
	if (!path) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Minecraft エージェント用 EventBuffer。
 * 固定間隔で resolve するタイマーベースの実装。
 * AgentRunner のコード変更なしで周期ポーリングを実現する。
 */
export class MinecraftEventBuffer implements EventBuffer {
	constructor(
		private readonly intervalMs: number,
		private readonly wakeSignalPath?: string,
		private readonly wakePollMs: number = DEFAULT_WAKE_POLL_MS,
	) {}

	/** Minecraft エージェントは Discord イベントを受けないため no-op */
	append(_event: BufferedEvent): void {
		// no-op
	}

	/** 固定間隔で resolve する */
	waitForEvents(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		const waits: Promise<void>[] = [sleep(this.intervalMs), waitForAbort(signal)];
		if (this.wakeSignalPath) waits.push(this.waitForWakeSignal(signal));
		return Promise.race(waits);
	}

	private waitForWakeSignal(signal: AbortSignal): Promise<void> {
		const initialWakeStamp = readWakeStamp(this.wakeSignalPath);
		const poll = async (): Promise<void> => {
			if (signal.aborted) return;
			await sleep(this.wakePollMs);
			const currentStamp = readWakeStamp(this.wakeSignalPath);
			if (currentStamp !== null && currentStamp !== initialWakeStamp) return;
			return poll();
		};
		return poll();
	}
}
