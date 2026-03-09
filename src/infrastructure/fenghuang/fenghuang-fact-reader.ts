import { existsSync } from "fs";
import { resolve } from "path";

import { SQLiteStorageAdapter } from "fenghuang";

import type { LtmFact, LtmFactReader } from "../../core/types.ts";

const GUILD_ID_RE = /^\d+$/;

export class FenghuangFactReader implements LtmFactReader {
	private readonly instances = new Map<string, SQLiteStorageAdapter>();

	constructor(private readonly dataDir: string) {}

	async getFacts(guildId?: string): Promise<LtmFact[]> {
		if (!guildId) return [];

		if (!GUILD_ID_RE.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}

		const dbPath = resolve(this.dataDir, "guilds", guildId, "memory.db");
		if (!existsSync(dbPath)) return [];

		const storage = this.getOrCreate(guildId, dbPath);
		const rawFacts = await storage.getFacts(guildId);
		return rawFacts.map((f) => ({
			content: f.fact,
			category: f.category,
			createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : String(f.createdAt),
		}));
	}

	close(): Promise<void> {
		for (const storage of this.instances.values()) {
			storage.close();
		}
		this.instances.clear();
		return Promise.resolve();
	}

	private getOrCreate(guildId: string, dbPath: string): SQLiteStorageAdapter {
		const existing = this.instances.get(guildId);
		if (existing) return existing;

		const storage = new SQLiteStorageAdapter(dbPath);
		this.instances.set(guildId, storage);
		return storage;
	}
}
