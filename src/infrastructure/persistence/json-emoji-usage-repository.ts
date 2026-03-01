import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";

import type { EmojiUsageCount } from "../../domain/entities/emoji-usage.ts";
import type { EmojiUsageTracker } from "../../domain/ports/emoji-usage-tracker.port.ts";

/** Guild ごとの絵文字名 → カウントのマップ */
type GuildEmojiMap = Record<string, Record<string, number>>;

const FLUSH_DELAY_MS = 30_000;

export class JsonEmojiUsageRepository implements EmojiUsageTracker {
	private readonly dataDir: string;
	private readonly filePath: string;
	private cache: GuildEmojiMap | null = null;
	private writing = false;
	private pendingWrite = false;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.filePath = resolve(dataDir, "emoji-usage.json");
	}

	increment(guildId: string, emojiName: string): void {
		const map = this.getMap();
		if (!map[guildId]) {
			map[guildId] = {};
		}
		map[guildId][emojiName] = (map[guildId][emojiName] ?? 0) + 1;
		this.scheduleDeferredFlush();
	}

	getTopEmojis(guildId: string, limit: number): EmojiUsageCount[] {
		const guildData = this.getMap()[guildId];
		if (!guildData) return [];

		return Object.entries(guildData)
			.map(([emojiName, count]) => ({ emojiName, count }))
			.toSorted((a, b) => b.count - a.count)
			.slice(0, limit);
	}

	hasData(guildId: string): boolean {
		const guildData = this.getMap()[guildId];
		return guildData !== undefined && Object.keys(guildData).length > 0;
	}

	/** Graceful shutdown 用: 保留中のデータを即時書き出す */
	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.persist();
	}

	private scheduleDeferredFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.persist();
		}, FLUSH_DELAY_MS);
	}

	private ensureDataDir(): void {
		if (!existsSync(this.dataDir)) {
			mkdirSync(this.dataDir, { recursive: true });
		}
	}

	private load(): GuildEmojiMap {
		this.ensureDataDir();
		if (!existsSync(this.filePath)) return {};
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			return JSON.parse(raw);
		} catch {
			return {};
		}
	}

	private getMap(): GuildEmojiMap {
		if (!this.cache) this.cache = this.load();
		return this.cache;
	}

	private async persist(): Promise<void> {
		if (this.writing) {
			this.pendingWrite = true;
			return;
		}
		this.writing = true;
		try {
			await this.writeFile();
		} finally {
			this.writing = false;
		}
	}

	private async writeFile(): Promise<void> {
		this.pendingWrite = false;
		this.ensureDataDir();
		await Bun.write(this.filePath, JSON.stringify(this.getMap(), null, 2));
		if (this.pendingWrite) return this.writeFile();
	}
}
