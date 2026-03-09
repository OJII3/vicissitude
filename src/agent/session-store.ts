import { count } from "drizzle-orm";

import type { StoreDb } from "../store/db.ts";
import { deleteSession, getSession, saveSession } from "../store/queries.ts";
import { sessions } from "../store/schema.ts";

export class SessionStore {
	constructor(private readonly db: StoreDb) {}

	get(agentName: string, sessionKey: string): string | undefined {
		return this.getRow(agentName, sessionKey)?.sessionId;
	}

	getCreatedAt(agentName: string, sessionKey: string): number | undefined {
		return this.getRow(agentName, sessionKey)?.createdAt;
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
		const result = this.db.select({ value: count() }).from(sessions).get();
		return result?.value ?? 0;
	}

	private makeKey(agentName: string, sessionKey: string): string {
		return `${agentName}:${sessionKey}`;
	}
}
