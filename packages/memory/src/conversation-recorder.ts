import { mkdirSync } from "fs";

import type {
	ConsolidationResult,
	ConversationMessage,
	ConversationRecorder,
	MemoryConsolidator,
} from "@vicissitude/shared/types";

import { ConsolidationPipeline } from "./consolidation.ts";
import type { Episode } from "./episode.ts";
import { EpisodicMemory } from "./episodic.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import {
	defaultSubject,
	type MemoryNamespace,
	namespaceKey,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
} from "./namespace.ts";
import { Segmenter } from "./segmenter.ts";
import { MemoryStorage } from "./storage.ts";
import type { ChatMessage } from "./types.ts";

export interface GuildInstance {
	segmenter: { addMessage(userId: string, msg: ChatMessage): Promise<Episode[]> };
	storage: { close(): void };
	consolidation: { consolidate(userId: string): Promise<ConsolidationResult> };
}

export type GuildInstanceFactory = (dbPath: string, llm: MemoryLlmPort) => GuildInstance;

const defaultFactory: GuildInstanceFactory = (dbPath, llm) => {
	const storage = new MemoryStorage(dbPath);
	const episodic = new EpisodicMemory(storage);
	const segmenter = new Segmenter(llm, storage);
	const consolidation = new ConsolidationPipeline(llm, storage, episodic);
	return { segmenter, storage, consolidation };
};

export class MemoryConversationRecorder implements ConversationRecorder, MemoryConsolidator {
	private readonly instances = new Map<string, { ns: MemoryNamespace; inst: GuildInstance }>();
	/** record() 用ロック: segmenter のキュー競合を防ぐ */
	private readonly locks = new Map<string, Promise<void>>();
	private readonly factory: GuildInstanceFactory;

	constructor(
		private readonly llm: MemoryLlmPort,
		private readonly dataDir: string,
		factory?: GuildInstanceFactory,
	) {
		this.factory = factory ?? defaultFactory;
	}

	async record(namespace: MemoryNamespace, message: ConversationMessage): Promise<void> {
		const key = namespaceKey(namespace);
		const subject = defaultSubject(namespace);

		// namespace ごとに直列化して segmenter のキュー競合を防ぐ
		const prev = this.locks.get(key) ?? Promise.resolve();
		const doRecord = async () => {
			await prev;
			const { segmenter } = this.getOrCreate(namespace);
			await segmenter.addMessage(subject, {
				role: message.role,
				content: message.content,
				name: message.name,
				timestamp: message.timestamp,
			});
		};
		const next = doRecord();
		this.locks.set(
			key,
			next.catch(() => {}),
		);
		await next;
	}

	getActiveNamespaces(): MemoryNamespace[] {
		return [...this.instances.values()].map((v) => v.ns);
	}

	consolidate(namespace: MemoryNamespace): Promise<ConsolidationResult> {
		// record() のロックとは独立: SQLite WAL モードで読み書き直列化は DB 側が保証するため、
		// consolidation が record() をブロックする必要はない
		const key = namespaceKey(namespace);
		const entry = this.instances.get(key);
		if (!entry) {
			return Promise.resolve({
				processedEpisodes: 0,
				newFacts: 0,
				reinforced: 0,
				updated: 0,
				invalidated: 0,
			});
		}
		return entry.inst.consolidation.consolidate(defaultSubject(namespace));
	}

	async close(): Promise<void> {
		// 進行中の record() を全て待ってから storage を閉じる
		await Promise.allSettled(this.locks.values());
		for (const { inst } of this.instances.values()) {
			inst.storage.close();
		}
		this.instances.clear();
		this.locks.clear();
	}

	private getOrCreate(namespace: MemoryNamespace): GuildInstance {
		const key = namespaceKey(namespace);
		const existing = this.instances.get(key);
		if (existing) return existing.inst;

		const dbDir = resolveMemoryDbDir(this.dataDir, namespace);
		mkdirSync(dbDir, { recursive: true });
		const inst = this.factory(resolveMemoryDbPath(this.dataDir, namespace), this.llm);
		this.instances.set(key, { ns: namespace, inst });
		return inst;
	}
}
