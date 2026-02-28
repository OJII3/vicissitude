import { existsSync } from "fs";
import { resolve } from "path";

import type { ContextLoader } from "../../domain/ports/context-loader.port.ts";

const BOOTSTRAP_FILES = [
	"IDENTITY.md",
	"SOUL.md",
	"AGENTS.md",
	"TOOLS.md",
	"USER.md",
	"MEMORY.md",
] as const;

const PER_FILE_MAX = 20_000;
const TOTAL_MAX = 150_000;

export class FileContextLoader implements ContextLoader {
	private readonly contextDir: string;

	constructor(contextDir: string) {
		this.contextDir = contextDir;
	}

	async loadBootstrapContext(): Promise<string> {
		const contents = await Promise.all(
			BOOTSTRAP_FILES.map((f) => this.readContextFile(f)),
		);

		const sections: string[] = [];
		let totalLength = 0;

		for (let i = 0; i < BOOTSTRAP_FILES.length; i++) {
			const content = contents[i];
			if (!content) continue;

			const filename = BOOTSTRAP_FILES[i];
			const section = `<${filename}>\n${content}\n</${filename}>`;
			if (totalLength + section.length > TOTAL_MAX) break;

			sections.push(section);
			totalLength += section.length;
		}

		const today = new Date().toISOString().slice(0, 10);
		const dailyLog = await this.readContextFile(`memory/${today}.md`);
		if (dailyLog) {
			const section = `<daily-log date="${today}">\n${dailyLog}\n</daily-log>`;
			if (totalLength + section.length <= TOTAL_MAX) {
				sections.push(section);
			}
		}

		return sections.join("\n\n");
	}

	async wrapWithContext(message: string): Promise<string> {
		const ctx = await this.loadBootstrapContext();
		if (!ctx) return message;

		return `## Project Context\n\n${ctx}\n\n---\n\n${message}`;
	}

	private async readContextFile(filename: string): Promise<string | null> {
		const filepath = resolve(this.contextDir, filename);
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
