import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";

import type { SessionRepository } from "../../domain/ports/session-repository.port.ts";

type SessionMap = Record<string, string>;

export class JsonSessionRepository implements SessionRepository {
	private readonly dataDir: string;
	private readonly filePath: string;
	private cache: SessionMap | null = null;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.filePath = resolve(dataDir, "sessions.json");
	}

	get(agentName: string, sessionKey: string): string | undefined {
		return this.getMap()[this.makeKey(agentName, sessionKey)];
	}

	async save(agentName: string, sessionKey: string, agentSessionId: string): Promise<void> {
		this.getMap()[this.makeKey(agentName, sessionKey)] = agentSessionId;
		await this.persist();
	}

	exists(agentName: string, sessionKey: string): boolean {
		return this.get(agentName, sessionKey) !== undefined;
	}

	private makeKey(agentName: string, sessionKey: string): string {
		return `${agentName}:${sessionKey}`;
	}

	private ensureDataDir(): void {
		if (!existsSync(this.dataDir)) {
			mkdirSync(this.dataDir, { recursive: true });
		}
	}

	private load(): SessionMap {
		this.ensureDataDir();
		if (!existsSync(this.filePath)) return {};
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}

	private getMap(): SessionMap {
		if (!this.cache) this.cache = this.load();
		return this.cache;
	}

	private persist(): Promise<void> {
		const prev = this.writeChain;
		this.writeChain = (async () => {
			await prev;
			this.ensureDataDir();
			await Bun.write(this.filePath, JSON.stringify(this.getMap(), null, 2));
		})();
		return this.writeChain;
	}
}
