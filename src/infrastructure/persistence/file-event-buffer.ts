import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

import type { BufferedEvent, EventBuffer } from "../../domain/ports/event-buffer.port.ts";

const BUFFER_FILENAME = "events.jsonl";

export class FileEventBuffer implements EventBuffer {
	private readonly filePath: string;

	constructor(dirPath: string) {
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
		}
		this.filePath = resolve(dirPath, BUFFER_FILENAME);
	}

	async append(event: BufferedEvent): Promise<void> {
		const line = `${JSON.stringify(event)}\n`;
		const file = Bun.file(this.filePath);
		const existing = (await file.exists()) ? await file.text() : "";
		await Bun.write(this.filePath, existing + line);
	}
}
