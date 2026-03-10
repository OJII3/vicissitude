import type { BufferedEvent, EventBuffer } from "../core/types.ts";

/**
 * Minecraft エージェント用 EventBuffer。
 * 固定間隔で resolve するタイマーベースの実装。
 * AgentRunner のコード変更なしで周期ポーリングを実現する。
 */
export class MinecraftEventBuffer implements EventBuffer {
	constructor(private readonly intervalMs: number) {}

	/** Minecraft エージェントは Discord イベントを受けないため no-op */
	append(_event: BufferedEvent): void {
		// no-op
	}

	/** 固定間隔で resolve する */
	waitForEvents(signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}

			let resolved = false;
			const done = () => {
				if (resolved) return;
				resolved = true;
				resolve();
			};

			const abortHandler = () => {
				clearTimeout(timer);
				done();
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abortHandler);
				done();
			}, this.intervalMs);
			signal.addEventListener("abort", abortHandler, { once: true });
		});
	}
}
