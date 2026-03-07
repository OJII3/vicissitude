import { mkdirSync } from "fs";
import { resolve } from "path";

import { ConsolidationPipeline, type LLMPort, SQLiteStorageAdapter, Segmenter } from "fenghuang";

import type {
	ConversationMessage,
	ConversationRecorder,
} from "../../domain/ports/conversation-recorder.port.ts";
import type {
	ConsolidationResult,
	MemoryConsolidator,
} from "../../domain/ports/memory-consolidator.port.ts";

const GUILD_ID_RE = /^\d+$/;

interface GuildInstance {
	segmenter: Segmenter;
	storage: SQLiteStorageAdapter;
	consolidation: ConsolidationPipeline;
}

export class FenghuangConversationRecorder implements ConversationRecorder, MemoryConsolidator {
	private readonly instances = new Map<string, GuildInstance>();
	private readonly locks = new Map<string, Promise<void>>();

	constructor(
		private readonly llm: LLMPort,
		private readonly dataDir: string,
	) {}

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

		// record() と同じロック機構を共有して競合を防止
		const prev = this.locks.get(guildId) ?? Promise.resolve();
		const doConsolidate = async () => {
			await prev;
			const { consolidation } = this.getOrCreate(guildId);
			return consolidation.consolidate(guildId);
		};
		const next = doConsolidate();
		/* oxlint-disable-next-line promise/always-return -- intentionally discard result for lock */
		const lock: Promise<void> = next.then(() => {}).catch(() => {});
		this.locks.set(guildId, lock);
		return next;
	}

	close(): void {
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
		const storage = new SQLiteStorageAdapter(resolve(dbDir, "memory.db"));
		const segmenter = new Segmenter(this.llm, storage);
		const consolidation = new ConsolidationPipeline(this.llm, storage);
		const instance = { segmenter, storage, consolidation };
		this.instances.set(guildId, instance);
		return instance;
	}
}
