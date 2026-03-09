import { existsSync } from "fs";
import { resolve } from "path";

import type { LtmFact } from "../core/types.ts";

export interface LtmFactReader {
	getFacts(guildId?: string): Promise<LtmFact[]>;
	close(): Promise<void>;
}

const SHARED_FILES = [
	"IDENTITY.md",
	"SOUL.md",
	"AGENTS.md",
	"TOOLS.md",
	"HEARTBEAT.md",
	"USER.md",
] as const;

const MEMORY_FILES = ["MEMORY.md", "LESSONS.md"] as const;

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 150_000;

export class ContextBuilder {
	constructor(
		private readonly overlayDir: string,
		private readonly baseDir: string,
		private readonly ltmFactReader?: LtmFactReader,
	) {}

	async build(guildId?: string): Promise<string> {
		const sections: string[] = [];
		let totalLength = 0;

		totalLength = await this.loadFileSections(guildId, sections, totalLength);
		totalLength = await this.loadDailyLog(guildId, sections, totalLength);
		totalLength = await this.loadLtmFacts(guildId, sections, totalLength);
		this.appendGuildContext(guildId, sections);

		return sections.join("\n\n");
	}

	private async loadFileSections(
		guildId: string | undefined,
		sections: string[],
		totalLength: number,
	): Promise<number> {
		const sharedContents = await Promise.all(SHARED_FILES.map((f) => this.readOverlaid(f)));
		const memoryContents = await Promise.all(
			MEMORY_FILES.map((f) => {
				if (guildId) {
					return this.readOverlaidWithGuildFallback(`guilds/${guildId}/${f}`, f);
				}
				return this.readOverlaid(f);
			}),
		);

		const allFiles = [...SHARED_FILES, ...MEMORY_FILES];
		const allContents = [...sharedContents, ...memoryContents];
		let len = totalLength;

		for (let i = 0; i < allFiles.length; i++) {
			const content = allContents[i];
			if (!content) continue;
			const filename = allFiles[i];
			const section = `<${filename}>\n${content}\n</${filename}>`;
			if (len + section.length > TOTAL_MAX) break;
			sections.push(section);
			len += section.length;
		}

		return len;
	}

	private async loadDailyLog(
		guildId: string | undefined,
		sections: string[],
		totalLength: number,
	): Promise<number> {
		const today = new Date().toISOString().slice(0, 10);
		const dailyLog = await this.readDailyLog(today, guildId);
		if (dailyLog) {
			const section = `<daily-log date="${today}">\n${dailyLog}\n</daily-log>`;
			if (totalLength + section.length <= TOTAL_MAX) {
				sections.push(section);
				return totalLength + section.length;
			}
		}
		return totalLength;
	}

	private async loadLtmFacts(
		guildId: string | undefined,
		sections: string[],
		totalLength: number,
	): Promise<number> {
		if (!guildId || !this.ltmFactReader) return totalLength;
		try {
			const facts = await this.ltmFactReader.getFacts(guildId);
			if (facts.length > 0) {
				const lines = facts.map((f) => `- [${f.category}] ${f.content}`);
				const section = `<ltm-facts>\n${lines.join("\n")}\n</ltm-facts>`;
				if (totalLength + section.length <= TOTAL_MAX) {
					sections.push(section);
					return totalLength + section.length;
				}
			}
		} catch {
			// LTM ファクト取得失敗時はスキップして続行
		}
		return totalLength;
	}

	private appendGuildContext(guildId: string | undefined, sections: string[]): void {
		if (guildId) {
			sections.push(
				`<guild-context>\ncurrent_guild_id: ${guildId}\nメモリツール使用時は guild_id: "${guildId}" を必ず指定してください。\n</guild-context>`,
			);
		}
	}

	private readDailyLog(date: string, guildId?: string): Promise<string | null> {
		if (guildId) {
			return this.readOverlaidWithGuildFallback(
				`guilds/${guildId}/memory/${date}.md`,
				`memory/${date}.md`,
			);
		}
		return this.readOverlaid(`memory/${date}.md`);
	}

	private async readOverlaidWithGuildFallback(
		guildRelativePath: string,
		globalRelativePath: string,
	): Promise<string | null> {
		const content = await this.readOverlaid(guildRelativePath);
		if (content) return content;
		return this.readOverlaid(globalRelativePath);
	}

	private async readOverlaid(relativePath: string): Promise<string | null> {
		const overlayPath = resolve(this.overlayDir, relativePath);
		const content = await this.readContextFile(overlayPath);
		if (content) return content;

		const basePath = resolve(this.baseDir, relativePath);
		return this.readContextFile(basePath);
	}

	private async readContextFile(filepath: string): Promise<string | null> {
		if (!existsSync(filepath)) return null;

		const content = await Bun.file(filepath).text();
		const trimmed = content.trim();
		if (!trimmed) return null;

		if (trimmed.length > PER_FILE_MAX) {
			return trimmed.slice(0, PER_FILE_MAX) + "\n\n[...truncated]";
		}
		return trimmed;
	}
}
