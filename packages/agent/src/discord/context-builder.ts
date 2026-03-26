import { resolve } from "path";

import type { ContextBuilderPort, MemoryFactReader } from "@vicissitude/shared/types";

const GUILD_ID_REGEX = /^\d+$/;

type FileEntry = { name: string; scope: "shared" | "guild" };

// Primacy-recency effect を考慮した並び順:
// 冒頭: キャラクター定義・教訓・記憶（重要度高）
// 中間: 行動規範・サーバー情報
// 末尾: ツール説明（ツール呼び出し時にスキーマが渡されるため参照頻度が低い）
const CONTEXT_FILES: readonly FileEntry[] = [
	// Phase 1: Identity & Memory
	{ name: "IDENTITY.md", scope: "shared" },
	{ name: "SOUL.md", scope: "shared" },
	{ name: "LESSONS.md", scope: "guild" },
	{ name: "MEMORY.md", scope: "guild" },
	// → memory-facts inserted after this phase
	// Phase 2: Behavior
	{ name: "DISCORD.md", scope: "shared" },
	{ name: "HEARTBEAT.md", scope: "shared" },
	// → guild-context inserted after this phase
	// Phase 3: Reference
	{ name: "SERVER.md", scope: "guild" },
	{ name: "TOOLS-CORE.md", scope: "shared" },
	{ name: "TOOLS-CODE.md", scope: "shared" },
	{ name: "TOOLS-MINECRAFT.md", scope: "shared" },
] as const;

const MEMORY_FACTS_AFTER = "MEMORY.md";
const GUILD_CONTEXT_AFTER = "HEARTBEAT.md";

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 150_000;

export class ContextBuilder implements ContextBuilderPort {
	constructor(
		private readonly overlayDir: string,
		private readonly baseDir: string,
		private readonly memoryFactReader?: MemoryFactReader,
	) {}

	async build(guildId?: string): Promise<string> {
		if (guildId !== undefined && !GUILD_ID_REGEX.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}

		const fileContents = await this.readAllFiles(guildId);
		const memoryFactsSection = await this.buildMemoryFactsSection(guildId);

		const sections: string[] = [];
		let totalLength = 0;

		for (let i = 0; i < CONTEXT_FILES.length; i++) {
			const entry = CONTEXT_FILES[i];
			const content = fileContents[i];

			if (content) {
				const section = `<${entry.name}>\n${content}\n</${entry.name}>`;
				if (totalLength + section.length > TOTAL_MAX) break;
				sections.push(section);
				totalLength += section.length;
			}

			if (
				entry.name === MEMORY_FACTS_AFTER &&
				memoryFactsSection &&
				totalLength + memoryFactsSection.length <= TOTAL_MAX
			) {
				sections.push(memoryFactsSection);
				totalLength += memoryFactsSection.length;
			}

			if (entry.name === GUILD_CONTEXT_AFTER && guildId) {
				const guildContext = `<guild-context>\ncurrent_guild_id: ${guildId}\n</guild-context>`;
				sections.push(guildContext);
				totalLength += guildContext.length;
			}
		}

		return sections.join("\n\n");
	}

	private readAllFiles(guildId: string | undefined): Promise<(string | null)[]> {
		return Promise.all(
			CONTEXT_FILES.map((entry) => {
				if (entry.scope === "guild") {
					if (!guildId) return Promise.resolve(null);
					return this.readOverlaid(`guilds/${guildId}/${entry.name}`);
				}
				return this.readOverlaid(entry.name);
			}),
		);
	}

	private async buildMemoryFactsSection(guildId: string | undefined): Promise<string | null> {
		if (!guildId || !this.memoryFactReader) return null;
		try {
			const facts = await this.memoryFactReader.getFacts(guildId);
			if (facts.length > 0) {
				const lines = facts.map((f) => `- [${f.category}] ${f.content}`);
				return `<memory-facts>\n${lines.join("\n")}\n</memory-facts>`;
			}
		} catch {
			// Memory ファクト取得失敗時はスキップして続行
		}
		return null;
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
