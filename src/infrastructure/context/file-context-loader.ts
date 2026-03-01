import { existsSync } from "fs";
import { resolve } from "path";

import type { ContextLoader } from "../../domain/ports/context-loader.port.ts";

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
	private readonly contextDir: string;
	private readonly guildId?: string;

	constructor(contextDir: string, guildId?: string) {
		this.contextDir = contextDir;
		this.guildId = guildId;
	}

	async loadBootstrapContext(): Promise<string> {
		const sharedContents = await Promise.all(
			SHARED_FILES.map((f) => this.readContextFile(resolve(this.contextDir, f))),
		);

		const guildMemoryDir = this.guildId ? resolve(this.contextDir, "guilds", this.guildId) : null;

		const memoryContents = await Promise.all(
			MEMORY_FILES.map((f) => {
				const guildPath = guildMemoryDir ? resolve(guildMemoryDir, f) : null;
				const globalPath = resolve(this.contextDir, f);
				return this.readContextFileWithFallback(guildPath, globalPath);
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

		if (this.guildId) {
			sections.push(
				`<guild-context>\ncurrent_guild_id: ${this.guildId}\nメモリツール使用時は guild_id: "${this.guildId}" を必ず指定してください。\n</guild-context>`,
			);
		}

		return sections.join("\n\n");
	}

	private async readDailyLog(date: string): Promise<string | null> {
		const guildLogPath = this.guildId
			? resolve(this.contextDir, "guilds", this.guildId, "memory", `${date}.md`)
			: null;
		const globalLogPath = resolve(this.contextDir, "memory", `${date}.md`);
		return this.readContextFileWithFallback(guildLogPath, globalLogPath);
	}

	private async readContextFileWithFallback(
		primaryPath: string | null,
		fallbackPath: string,
	): Promise<string | null> {
		if (primaryPath) {
			const content = await this.readContextFile(primaryPath);
			if (content) return content;
		}
		return this.readContextFile(fallbackPath);
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
