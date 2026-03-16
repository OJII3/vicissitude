import { mkdirSync } from "fs";
import { resolve } from "path";

import type {
	ConsolidationResult,
	ConversationMessage,
	ConversationRecorder,
	MemoryConsolidator,
} from "@vicissitude/shared/types";

import { ConsolidationPipeline } from "./consolidation.ts";
import type { Episode } from "./episode.ts";
import { EpisodicMemory } from "./episodic.ts";
import type { LtmLlmPort } from "./llm-port.ts";
import { LtmStorage } from "./ltm-storage.ts";
import { Segmenter } from "./segmenter.ts";

const GUILD_ID_RE = /^\d+$/;

export interface GuildInstance {
	segmenter: { addMessage(userId: string, msg: unknown): Promise<Episode[]> };
	storage: { close(): void };
	consolidation: { consolidate(userId: string): Promise<ConsolidationResult> };
}

export type GuildInstanceFactory = (dbPath: string, llm: LtmLlmPort) => GuildInstance;

const defaultFactory: GuildInstanceFactory = (dbPath, llm) => {
	const storage = new LtmStorage(dbPath);
	const episodic = new EpisodicMemory(storage);
	const segmenter = new Segmenter(llm, storage);
	const consolidation = new ConsolidationPipeline(llm, storage, episodic);
	return { segmenter, storage, consolidation };
};

export class LtmConversationRecorder implements ConversationRecorder, MemoryConsolidator {
	private readonly instances = new Map<string, GuildInstance>();
	/** record() 用ロック: segmenter のキュー競合を防ぐ */
	private readonly locks = new Map<string, Promise<void>>();
	private readonly factory: GuildInstanceFactory;

	constructor(
		private readonly llm: LtmLlmPort,
		private readonly dataDir: string,
		factory?: GuildInstanceFactory,
	) {
		this.factory = factory ?? defaultFactory;
	}

	async record(guildId: string, message: ConversationMessage): Promise<void> {
		if (!GUILD_ID_RE.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}

		// guild ごとに直列化して segmenter のキュー競合を防ぐ
		const prev = this.locks.get(guildId) ?? Promise.resolve();
		const doRecord = async () => {
			await prev;
			const { segmenter } = this.getOrCreate(guildId);
			await segmenter.addMessage(guildId, {
				role: message.role,
				content: message.content,
				name: message.name,
				timestamp: message.timestamp,
			});
		};
		const next = doRecord();
		this.locks.set(
			guildId,
			next.catch(() => {}),
		);
		await next;
	}

	getActiveGuildIds(): string[] {
		return [...this.instances.keys()];
	}

	consolidate(guildId: string): Promise<ConsolidationResult> {
		if (!GUILD_ID_RE.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}

		// record() のロックとは独立: SQLite WAL モードで読み書き直列化は DB 側が保証するため、
		// consolidation が record() をブロックする必要はない
		const instance = this.instances.get(guildId);
		if (!instance) {
			return Promise.resolve({
				processedEpisodes: 0,
				newFacts: 0,
				reinforced: 0,
				updated: 0,
				invalidated: 0,
			});
		}
		return instance.consolidation.consolidate(guildId);
	}

	async close(): Promise<void> {
		// 進行中の record() を全て待ってから storage を閉じる
		await Promise.allSettled(this.locks.values());
		for (const { storage } of this.instances.values()) {
			storage.close();
		}
		this.instances.clear();
		this.locks.clear();
	}

	private getOrCreate(guildId: string): GuildInstance {
		const existing = this.instances.get(guildId);
		if (existing) return existing;

		const dbDir = resolve(this.dataDir, "guilds", guildId);
		mkdirSync(dbDir, { recursive: true });
		const instance = this.factory(resolve(dbDir, "memory.db"), this.llm);
		this.instances.set(guildId, instance);
		return instance;
	}
}
