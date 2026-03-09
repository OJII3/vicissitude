import type { BufferedEvent, EventBuffer } from "../core/types.ts";

/**
 * Minecraft サブブレイン用 EventBuffer。
 * 固定間隔で resolve するタイマーベースの実装。
 * AgentRunner のコード変更なしで周期ポーリングを実現する。
 */
export class MinecraftEventBuffer implements EventBuffer {
	constructor(private readonly intervalMs: number) {}

	/** サブブレインは Discord イベントを受けないため no-op */
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

			const timer = setTimeout(done, this.intervalMs);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					done();
				},
				{ once: true },
			);
		});
	}
}
