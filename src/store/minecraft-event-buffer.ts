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

function createAbortWait(signal: AbortSignal): { promise: Promise<void>; cleanup: () => void } {
	let onAbort: (() => void) | undefined;
	const cleanup = () => {
		if (!onAbort) return;
		signal.removeEventListener("abort", onAbort);
		onAbort = undefined;
	};
	const promise = new Promise<void>((resolve) => {
		onAbort = () => {
			cleanup();
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return { promise, cleanup };
}

function createSleepWait(ms: number): { promise: Promise<void>; cleanup: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	};
	const promise = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			timer = undefined;
			resolve();
		}, ms);
	});
	return { promise, cleanup };
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
		const localController = new AbortController();
		const forwardAbort = () => localController.abort();
		signal.addEventListener("abort", forwardAbort, { once: true });
		const abortWait = createAbortWait(signal);
		const sleepWait = createSleepWait(this.intervalMs);

		const waits: Promise<void>[] = [sleepWait.promise, abortWait.promise];
		if (this.wakeSignalPath) waits.push(this.waitForWakeSignal(localController.signal));

		return Promise.race(waits).finally(() => {
			localController.abort();
			abortWait.cleanup();
			sleepWait.cleanup();
			signal.removeEventListener("abort", forwardAbort);
		});
	}

	private waitForWakeSignal(signal: AbortSignal): Promise<void> {
		const initialWakeStamp = readWakeStamp(this.wakeSignalPath);
		const poll = async (): Promise<void> => {
			if (signal.aborted) return;
			const sleepWait = createSleepWait(this.wakePollMs);
			const abortWait = createAbortWait(signal);
			try {
				await Promise.race([sleepWait.promise, abortWait.promise]);
			} finally {
				sleepWait.cleanup();
				abortWait.cleanup();
			}
			if (signal.aborted) return;
			const currentStamp = readWakeStamp(this.wakeSignalPath);
			if (currentStamp !== null && currentStamp !== initialWakeStamp) return;
			return poll();
		};
		return poll();
	}
}
