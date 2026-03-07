import { appendFileSync, existsSync, mkdirSync, statSync, watch } from "fs";
import { join } from "path";

import type { BufferedEvent, EventBuffer } from "../../domain/ports/event-buffer.port.ts";

const BUFFER_FILENAME = "events.jsonl";
const POLL_INTERVAL_MS = 30_000;

export class FileEventBuffer implements EventBuffer {
	private readonly filePath: string;
	private readonly dirPath: string;

	constructor(dirPath: string) {
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
		}
		this.dirPath = dirPath;
		this.filePath = join(dirPath, BUFFER_FILENAME);
	}

	append(event: BufferedEvent): Promise<void> {
		const line = `${JSON.stringify(event)}\n`;
		appendFileSync(this.filePath, line);
		return Promise.resolve();
	}

	waitForEvents(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		if (this.hasBufferedEvents()) return Promise.resolve();

		return new Promise<void>((resolve) => {
			let settled = false;

			const cleanup = () => {
				if (settled) return;
				settled = true;
				watcher.close();
				clearInterval(pollTimer);
				signal.removeEventListener("abort", cleanup);
				// oxlint-disable-next-line no-multiple-resolved -- settled guard prevents multiple resolve
				resolve();
			};

			const watcher = watch(this.dirPath, (_eventType, filename) => {
				if (filename === BUFFER_FILENAME && this.hasBufferedEvents()) {
					cleanup();
				}
			});

			const pollTimer = setInterval(() => {
				if (this.hasBufferedEvents()) {
					cleanup();
				}
			}, POLL_INTERVAL_MS);

			signal.addEventListener("abort", cleanup, { once: true });
		});
	}

	private hasBufferedEvents(): boolean {
		if (!existsSync(this.filePath)) return false;
		try {
			return statSync(this.filePath).size > 0;
		} catch {
			return false;
		}
	}
}
