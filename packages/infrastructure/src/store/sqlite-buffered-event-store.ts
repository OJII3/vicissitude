import type { BufferedEventStore } from "@vicissitude/application/message-ingestion-service";
import type { BufferedEvent } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { appendEvent } from "@vicissitude/store/queries";

export class SqliteBufferedEventStore implements BufferedEventStore {
	constructor(private readonly db: StoreDb) {}

	append(agentId: string, event: BufferedEvent): void {
		appendEvent(this.db, agentId, JSON.stringify(event));
	}
}
