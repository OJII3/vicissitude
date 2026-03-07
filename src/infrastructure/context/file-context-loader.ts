import { existsSync } from "fs";
import { resolve } from "path";

import type { ContextLoader } from "../../domain/ports/context-loader.port.ts";
import type { LtmFactReader } from "../../domain/ports/ltm-fact-reader.port.ts";

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

export class FileContextLoader implements ContextLoader {
	private readonly overlayDir: string;
	private readonly baseDir: string;
	private readonly guildId?: string;
	private readonly ltmFactReader?: LtmFactReader;

	constructor(
		overlayDir: string,
		baseDir: string,
		guildId?: string,
		ltmFactReader?: LtmFactReader,
	) {
		this.overlayDir = overlayDir;
		this.baseDir = baseDir;
		this.guildId = guildId;
		this.ltmFactReader = ltmFactReader;
	}

	async loadBootstrapContext(): Promise<string> {
		const sharedContents = await Promise.all(SHARED_FILES.map((f) => this.readOverlaid(f)));

		const memoryContents = await Promise.all(
			MEMORY_FILES.map((f) => {
				if (this.guildId) {
					return this.readOverlaidWithGuildFallback(`guilds/${this.guildId}/${f}`, f);
				}
				return this.readOverlaid(f);
			}),
		);

		const sections: string[] = [];
		let totalLength = 0;

		const allFiles = [...SHARED_FILES, ...MEMORY_FILES];
		const allContents = [...sharedContents, ...memoryContents];

		for (let i = 0; i < allFiles.length; i++) {
			const content = allContents[i];
			if (!content) continue;

			const filename = allFiles[i];
			const section = `<${filename}>\n${content}\n</${filename}>`;
			if (totalLength + section.length > TOTAL_MAX) break;

			sections.push(section);
			totalLength += section.length;
		}

		const today = new Date().toISOString().slice(0, 10);
		const dailyLog = await this.readDailyLog(today);
		if (dailyLog) {
			const section = `<daily-log date="${today}">\n${dailyLog}\n</daily-log>`;
			if (totalLength + section.length <= TOTAL_MAX) {
				sections.push(section);
			}
		}

		if (this.guildId && this.ltmFactReader) {
			const facts = await this.ltmFactReader.getFacts(this.guildId);
			if (facts.length > 0) {
				const lines = facts.map((f) => `- [${f.category}] ${f.content}`);
				const section = `<ltm-facts>\n${lines.join("\n")}\n</ltm-facts>`;
				if (totalLength + section.length <= TOTAL_MAX) {
					sections.push(section);
					totalLength += section.length;
				}
			}
		}

		if (this.guildId) {
			sections.push(
				`<guild-context>\ncurrent_guild_id: ${this.guildId}\nメモリツール使用時は guild_id: "${this.guildId}" を必ず指定してください。\n</guild-context>`,
			);
		}

		return sections.join("\n\n");
	}

	private async readDailyLog(date: string): Promise<string | null> {
		if (this.guildId) {
			return this.readOverlaidWithGuildFallback(
				`guilds/${this.guildId}/memory/${date}.md`,
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
