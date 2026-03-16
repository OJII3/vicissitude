import type { BufferedEventStore } from "../../application/message-ingestion-service.ts";
import type { BufferedEvent } from "@vicissitude/shared/types";
import type { StoreDb } from "../../store/db.ts";
import { appendEvent } from "../../store/queries.ts";

export class SqliteBufferedEventStore implements BufferedEventStore {
	constructor(private readonly db: StoreDb) {}

	append(agentId: string, event: BufferedEvent): void {
		appendEvent(this.db, agentId, JSON.stringify(event));
	}
}
