import type { SessionStorePort } from "@vicissitude/shared/types";

import type { StoreDb } from "./db.ts";
import { countSessions, deleteSession, getSession, saveSession } from "./queries.ts";

export class SqliteSessionStore implements SessionStorePort {
	constructor(private readonly db: StoreDb) {}

	get(agentName: string, sessionKey: string): string | undefined {
		return this.getRow(agentName, sessionKey)?.sessionId;
	}

	getRow(
		agentName: string,
		sessionKey: string,
	): { sessionId: string; createdAt: number } | undefined {
		const row = getSession(this.db, this.makeKey(agentName, sessionKey));
		if (!row) return undefined;
		return { sessionId: row.sessionId, createdAt: row.createdAt };
	}

	save(agentName: string, sessionKey: string, sessionId: string): void {
		saveSession(this.db, this.makeKey(agentName, sessionKey), sessionId);
	}

	delete(agentName: string, sessionKey: string): void {
		deleteSession(this.db, this.makeKey(agentName, sessionKey));
	}

	count(): number {
		return countSessions(this.db);
	}

	private makeKey(agentName: string, sessionKey: string): string {
		return `${agentName}:${sessionKey}`;
	}
}

export function createSqliteSessionStore(db: StoreDb): SessionStorePort {
	return new SqliteSessionStore(db);
}
