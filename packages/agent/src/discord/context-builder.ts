import { resolve } from "path";

import type {
	ContextBuilderPort,
	MemoryFactReader,
	McStatusProvider,
} from "@vicissitude/shared/types";

const GUILD_ID_REGEX = /^\d+$/;

const SHARED_FILES = [
	"IDENTITY.md",
	"SOUL.md",
	"DISCORD.md",
	"HEARTBEAT.md",
	"TOOLS-CORE.md",
	"TOOLS-CODE.md",
	"TOOLS-MINECRAFT.md",
] as const;

const GUILD_FILES = ["SERVER.md"] as const;

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 150_000;

export class ContextBuilder implements ContextBuilderPort {
	constructor(
		private readonly overlayDir: string,
		private readonly baseDir: string,
		private readonly memoryFactReader?: MemoryFactReader,
		private readonly mcStatusProvider?: McStatusProvider,
	) {}

	async build(guildId?: string): Promise<string> {
		if (guildId !== undefined && !GUILD_ID_REGEX.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}

		const sections: string[] = [];
		let totalLength = 0;

		totalLength = await this.loadFileSections(guildId, sections, totalLength);
		totalLength = await this.loadMemoryFacts(guildId, sections, totalLength);
		totalLength = await this.loadMinecraftStatus(sections, totalLength);
		this.appendGuildContext(guildId, sections);

		return sections.join("\n\n");
	}

	private async loadFileSections(
		guildId: string | undefined,
		sections: string[],
		totalLength: number,
	): Promise<number> {
		const sharedContents = await Promise.all(SHARED_FILES.map((f) => this.readOverlaid(f)));
		const guildContents = await Promise.all(
			GUILD_FILES.map((f) => {
				if (guildId) {
					return this.readOverlaid(`guilds/${guildId}/${f}`);
				}
				return Promise.resolve(null);
			}),
		);

		const allFiles = [...SHARED_FILES, ...GUILD_FILES];
		const allContents = [...sharedContents, ...guildContents];
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

	private async loadMemoryFacts(
		guildId: string | undefined,
		sections: string[],
		totalLength: number,
	): Promise<number> {
		if (!guildId || !this.memoryFactReader) return totalLength;
		try {
			const facts = await this.memoryFactReader.getFacts(guildId);
			if (facts.length > 0) {
				const lines = facts.map((f) => `- [${f.category}] ${f.content}`);
				const section = `<memory-facts>\n${lines.join("\n")}\n</memory-facts>`;
				if (totalLength + section.length <= TOTAL_MAX) {
					sections.push(section);
					return totalLength + section.length;
				}
			}
		} catch {
			// Memory ファクト取得失敗時はスキップして続行
		}
		return totalLength;
	}

	private async loadMinecraftStatus(sections: string[], totalLength: number): Promise<number> {
		if (!this.mcStatusProvider) return totalLength;
		try {
			const summary = await this.mcStatusProvider.getStatusSummary();
			if (summary) {
				const section = `<minecraft-status>\n${summary}\n</minecraft-status>`;
				if (totalLength + section.length <= TOTAL_MAX) {
					sections.push(section);
					return totalLength + section.length;
				}
			}
		} catch {
			// Minecraft ステータス取得失敗時はスキップして続行
		}
		return totalLength;
	}

	private appendGuildContext(guildId: string | undefined, sections: string[]): void {
		if (guildId) {
			sections.push(`<guild-context>\ncurrent_guild_id: ${guildId}\n</guild-context>`);
		}
	}

	private async readOverlaid(relativePath: string): Promise<string | null> {
		const overlayPath = resolve(this.overlayDir, relativePath);
		const content = await this.readContextFile(overlayPath);
		if (content) return content;

		const basePath = resolve(this.baseDir, relativePath);
		return this.readContextFile(basePath);
	}

	private async readContextFile(filepath: string): Promise<string | null> {
		try {
			const content = await Bun.file(filepath).text();
			const trimmed = content.trim();
			if (!trimmed) return null;

			if (trimmed.length > PER_FILE_MAX) {
				return trimmed.slice(0, PER_FILE_MAX) + "\n\n[...truncated]";
			}
			return trimmed;
		} catch {
			return null;
		}
	}
}
