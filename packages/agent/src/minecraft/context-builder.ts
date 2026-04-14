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
 * オーバーレイ方式（data/context/minecraft/ → context/minecraft/）で
 * Minecraft 用コンテキストファイルを読み込む。
 * Guild 非依存（guildId 引数は無視）。
 */
export class MinecraftContextBuilder implements ContextBuilderPort {
	constructor(
		private readonly overlayDir: string,
		private readonly baseDir: string,
	) {}

	async build(_guildId?: string): Promise<string> {
		const sections: string[] = [];
		let totalLength = 0;

		for (const filename of CONTEXT_FILES) {
			// oxlint-disable-next-line no-await-in-loop -- sequential file loading is intentional
			const content = await this.readOverlaid(filename);
			if (!content) continue;
			const section = `<${filename}>\n${content}\n</${filename}>`;
			if (totalLength + section.length > TOTAL_MAX) break;
			sections.push(section);
			totalLength += section.length;
		}

		return sections.join("\n\n");
	}

	private async readOverlaid(relativePath: string): Promise<string | null> {
		const overlayPath: string = resolve(this.overlayDir, relativePath);
		const content = await this.readFile(overlayPath);
		if (content) return content;

		const basePath: string = resolve(this.baseDir, relativePath);
		return this.readFile(basePath);
	}

	private async readFile(filepath: string): Promise<string | null> {
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
