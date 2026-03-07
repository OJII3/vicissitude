import { mkdirSync } from "fs";
import { resolve } from "path";

import { type Fenghuang, type LLMPort, SQLiteStorageAdapter, createFenghuang } from "fenghuang";

import type {
	ConversationMessage,
	ConversationRecorder,
} from "../../domain/ports/conversation-recorder.port.ts";

export class FenghuangConversationRecorder implements ConversationRecorder {
	private readonly instances = new Map<string, Fenghuang>();

	constructor(
		private readonly llm: LLMPort,
		private readonly dataDir: string,
	) {}

	async record(guildId: string, message: ConversationMessage): Promise<void> {
		const feng = this.getOrCreate(guildId);
		await feng.segmenter.addMessage(guildId, {
			role: message.role,
			content: message.content,
			timestamp: message.timestamp,
		});
	}

	close(): void {
		this.instances.clear();
	}

	private getOrCreate(guildId: string): Fenghuang {
		const existing = this.instances.get(guildId);
		if (existing) return existing;

		const dbDir = resolve(this.dataDir, "guilds", guildId);
		mkdirSync(dbDir, { recursive: true });
		const storage = new SQLiteStorageAdapter(resolve(dbDir, "memory.db"));
		const instance = createFenghuang({ llm: this.llm, storage });
		this.instances.set(guildId, instance);
		return instance;
	}
}
