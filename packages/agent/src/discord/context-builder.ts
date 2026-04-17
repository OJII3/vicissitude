import { resolve } from "path";

import { discordGuildNamespace, GUILD_ID_RE } from "@vicissitude/shared/namespace";
import type { ContextBuilderPort, MemoryFact, MemoryFactReader } from "@vicissitude/shared/types";

type FileEntry = { name: string; scope: "shared" | "guild" };

// Primacy-recency effect を考慮した並び順:
// 冒頭: キャラクター定義・教訓・記憶（重要度高）
// 中間: 行動規範・サーバー情報
// 末尾: ツール説明（ツール呼び出し時にスキーマが渡されるため参照頻度が低い）
const CONTEXT_FILES = [
	// Phase 1: Identity & Memory
	{ name: "IDENTITY.md", scope: "shared" },
	{ name: "SOUL.md", scope: "shared" },
	{ name: "LESSONS.md", scope: "guild" },
	{ name: "MEMORY.md", scope: "guild" },
	{ name: "SESSION-SUMMARY.md", scope: "guild" },
	// Phase 2: Behavior
	{ name: "DISCORD.md", scope: "shared" },
	{ name: "HEARTBEAT.md", scope: "shared" },
	// → guild-context inserted after this phase
	// Phase 3: Reference
	{ name: "SERVER.md", scope: "guild" },
	{ name: "TOOLS-CORE.md", scope: "shared" },
	{ name: "TOOLS-CODE.md", scope: "shared" },
	{ name: "TOOLS-MINECRAFT.md", scope: "shared" },
] as const satisfies readonly FileEntry[];

type ContextFileName = (typeof CONTEXT_FILES)[number]["name"];
const GUILD_CONTEXT_AFTER: ContextFileName = "HEARTBEAT.md";

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 150_000;

export class ContextBuilder implements ContextBuilderPort {
	constructor(
		private readonly overlayDir: string,
		private readonly baseDir: string,
		private readonly factReader?: MemoryFactReader,
		private readonly excludeFiles?: ReadonlySet<string>,
	) {}

	async build(guildId?: string): Promise<string> {
		if (guildId !== undefined && !GUILD_ID_RE.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}

		const fileContents = await this.readAllFiles(guildId);
		const factsSection = await this.buildFactsSection(guildId);

		const sections: string[] = [];
		let totalLength = 0;

		for (let i = 0; i < CONTEXT_FILES.length; i++) {
			const entry = CONTEXT_FILES[i];
			if (!entry) continue;
			if (this.excludeFiles?.has(entry.name)) continue;
			const content = fileContents[i];

			if (content) {
				const section = `<${entry.name}>\n${content}\n</${entry.name}>`;
				if (totalLength + section.length > TOTAL_MAX) break;
				sections.push(section);
				totalLength += section.length;
			}

			if (
				entry.name === "SESSION-SUMMARY.md" &&
				factsSection &&
				totalLength + factsSection.length <= TOTAL_MAX
			) {
				sections.push(factsSection);
				totalLength += factsSection.length;
			}

			if (entry.name === GUILD_CONTEXT_AFTER && guildId) {
				const guildContext = `<guild-context>\ncurrent_guild_id: ${guildId}\n</guild-context>`;
				if (totalLength + guildContext.length <= TOTAL_MAX) {
					sections.push(guildContext);
					totalLength += guildContext.length;
				}
			}
		}

		return sections.join("\n\n");
	}

	/** Maximum facts to inject into system prompt */
	private static readonly FACTS_LIMIT = 20;

	private async buildFactsSection(guildId?: string): Promise<string | null> {
		if (!this.factReader || !guildId) return null;

		const facts = await this.factReader.getRelevantFacts(
			discordGuildNamespace(guildId),
			"",
			ContextBuilder.FACTS_LIMIT,
		);
		if (facts.length === 0) return null;

		const guidelines: MemoryFact[] = [];
		const others: MemoryFact[] = [];
		for (const fact of facts) {
			if (fact.category === "guideline") {
				guidelines.push(fact);
			} else {
				others.push(fact);
			}
		}

		const lines: string[] = [];
		if (guidelines.length > 0) {
			lines.push("## 行動ガイドライン");
			for (const g of guidelines) {
				lines.push(`- ${g.content}`);
			}
			lines.push("");
		}
		for (const f of others) {
			lines.push(`- ${f.content}`);
		}

		return `<MEMORY-FACTS>\n${lines.join("\n").trim()}\n</MEMORY-FACTS>`;
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

	private async readOverlaid(relativePath: string): Promise<string | null> {
		const overlayPath: string = resolve(this.overlayDir, relativePath);
		const content = await this.readContextFile(overlayPath);
		if (content) return content;

		const basePath: string = resolve(this.baseDir, relativePath);
		return this.readContextFile(basePath);
	}

	private async readContextFile(filepath: string): Promise<string | null> {
		try {
			const content = await Bun.file(filepath).text();
			const trimmed: string = content.trim();
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
