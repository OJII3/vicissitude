import type { BufferedEventStore } from "../../application/message-ingestion-service.ts";
import type { BufferedEvent } from "../../core/types.ts";
import type { StoreDb } from "../../store/db.ts";
import { appendEvent } from "../../store/queries.ts";

export class SqliteBufferedEventStore implements BufferedEventStore {
	constructor(private readonly db: StoreDb) {}

	append(guildId: string, event: BufferedEvent): void {
		appendEvent(this.db, guildId, JSON.stringify(event));
	}
}
