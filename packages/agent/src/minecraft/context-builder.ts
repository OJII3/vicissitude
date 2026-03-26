import { resolve } from "path";

import type { ContextBuilderPort } from "@vicissitude/shared/types";

const CONTEXT_FILES = [
	"MINECRAFT-IDENTITY.md",
	"MINECRAFT-KNOWLEDGE.md",
	"MINECRAFT-GOALS.md",
	"MINECRAFT-PROGRESS.md",
] as const;

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 150_000;

/**
 * Minecraft エージェント専用コンテキストビルダー。
 * data → static のフォールバック方式で Minecraft 用コンテキストファイルを読み込む。
 * GOALS/PROGRESS はランタイム書き換え対象のため、data 側を優先する。
 * Guild 非依存（guildId 引数は無視）。
 */
export class MinecraftContextBuilder implements ContextBuilderPort {
	constructor(
		private readonly dataDir: string,
		private readonly staticDir: string,
	) {}

	async build(_guildId?: string): Promise<string> {
		const sections: string[] = [];
		let totalLength = 0;

		for (const filename of CONTEXT_FILES) {
			// oxlint-disable-next-line no-await-in-loop -- sequential file loading is intentional
			const content = await this.readWithFallback(filename);
			if (!content) continue;
			const section = `<${filename}>\n${content}\n</${filename}>`;
			if (totalLength + section.length > TOTAL_MAX) break;
			sections.push(section);
			totalLength += section.length;
		}

		return sections.join("\n\n");
	}

	private async readWithFallback(relativePath: string): Promise<string | null> {
		const dataPath = resolve(this.dataDir, relativePath);
		const content = await this.readFile(dataPath);
		if (content) return content;

		const staticPath = resolve(this.staticDir, relativePath);
		return this.readFile(staticPath);
	}

	private async readFile(filepath: string): Promise<string | null> {
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
