import type { BufferedEvent, EventBuffer } from "../core/types.ts";
import type { StoreDb } from "./db.ts";
import { getLatestDiscordBridgeEventIdForGuild } from "./mc-bridge.ts";
import { appendEvent, hasEvents } from "./queries.ts";

export class SqliteEventBuffer implements EventBuffer {
	private lastSeenDiscordBridgeEventId: number | null = null;

	constructor(
		private readonly db: StoreDb,
		private readonly guildId: string,
	) {}

	append(event: BufferedEvent): void {
		appendEvent(this.db, this.guildId, JSON.stringify(event));
	}

	waitForEvents(signal: AbortSignal): Promise<void> {
		const POLL_MIN_MS = 500;
		const POLL_MAX_MS = 5000;

		// oxlint-disable-next-line no-shadow -- Promise parameter shadows `resolve` import, intentional
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let resolved = false;
			let interval = POLL_MIN_MS;
			const done = () => {
				if (resolved) return;
				resolved = true;
				resolve();
			};
			const poll = () => {
				if (signal.aborted) {
					done();
					return;
				}
				if (hasEvents(this.db, this.guildId)) {
					done();
					return;
				}
				const bridgeEventId = getLatestDiscordBridgeEventIdForGuild(this.db, this.guildId);
				if (
					bridgeEventId !== null &&
					(this.lastSeenDiscordBridgeEventId === null ||
						bridgeEventId > this.lastSeenDiscordBridgeEventId)
				) {
					this.lastSeenDiscordBridgeEventId = bridgeEventId;
					done();
					return;
				}
				timer = setTimeout(poll, interval);
				interval = Math.min(interval * 1.5, POLL_MAX_MS);
			};
			signal.addEventListener(
				"abort",
				() => {
					if (timer) clearTimeout(timer);
					done();
				},
				{ once: true },
			);
			poll();
		});
	}
}
