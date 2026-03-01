import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path, { resolve } from "path";

import { z } from "zod";

export const BASE_CONTEXT_DIR = resolve(import.meta.dirname, "../../context");
export const OVERLAY_CONTEXT_DIR = resolve(import.meta.dirname, "../../data/context");
export const SOUL_PATH = resolve(OVERLAY_CONTEXT_DIR, "SOUL.md");

export const MAX_MEMORY_CHARS = 50_000;
export const MAX_LESSONS_CHARS = 30_000;
export const MAX_SOUL_LEARNED_CHARS = 10_000;
export const MAX_ENTRY_CHARS = 2_000;
export const MAX_DAILY_LOG_CHARS = 20_000;
export const MAX_DAILY_LOG_AGE_DAYS = 7;

const GUILD_ID_REGEX = /^\d+$/;

export const guildIdSchema = z
	.string()
	.regex(GUILD_ID_REGEX, "guild_id は Discord snowflake（数字のみ）である必要があります")
	.optional()
	.describe("Guild ID（指定時は Guild 固有のメモリを使用、省略時はグローバル）");

export interface ContextPaths {
	memoryPath: string;
	lessonsPath: string;
	memoryDir: string;
}

export function resolveContextPaths(guildId?: string): ContextPaths {
	if (guildId) {
		const guildDir = resolve(OVERLAY_CONTEXT_DIR, "guilds", guildId);
		return {
			memoryPath: resolve(guildDir, "MEMORY.md"),
			lessonsPath: resolve(guildDir, "LESSONS.md"),
			memoryDir: resolve(guildDir, "memory"),
		};
	}
	return {
		memoryPath: resolve(OVERLAY_CONTEXT_DIR, "MEMORY.md"),
		lessonsPath: resolve(OVERLAY_CONTEXT_DIR, "LESSONS.md"),
		memoryDir: resolve(OVERLAY_CONTEXT_DIR, "memory"),
	};
}

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readFileSafe(filePath: string): string {
	if (!existsSync(filePath)) return "";
	return readFileSync(filePath, "utf-8");
}

export function readWithFallback(overlayPath: string): string {
	const content = readFileSafe(overlayPath);
	if (content) return content;
	const relative = path.relative(OVERLAY_CONTEXT_DIR, overlayPath);
	return readFileSafe(resolve(BASE_CONTEXT_DIR, relative));
}

export function createBackup(filePath: string): void {
	if (existsSync(filePath)) {
		writeFileSync(`${filePath}.bak`, readFileSync(filePath));
	}
}

export function todayDateString(): string {
	const now = new Date();
	const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	return jst.toISOString().slice(0, 10);
}

export function isDateWithinRange(dateStr: string): boolean {
	const target = new Date(`${dateStr}T00:00:00+09:00`);
	const now = new Date();
	const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	const today = new Date(`${jstNow.toISOString().slice(0, 10)}T00:00:00+09:00`);
	const diffDays = (today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24);
	return diffDays >= 0 && diffDays <= MAX_DAILY_LOG_AGE_DAYS;
}

export function guildLabel(guildId?: string): string {
	return guildId ? `[guild:${guildId}] ` : "";
}

export function extractLearnedSection(content: string): {
	before: string;
	section: string;
	after: string;
} {
	const marker = "## 学んだこと";
	const idx = content.indexOf(marker);
	if (idx === -1) return { before: content, section: "", after: "" };

	const before = content.slice(0, idx);
	const rest = content.slice(idx);

	const nextSectionMatch = rest.slice(marker.length).search(/\n## /);
	if (nextSectionMatch === -1) {
		return { before, section: rest, after: "" };
	}
	const sectionEnd = marker.length + nextSectionMatch;
	return { before, section: rest.slice(0, sectionEnd), after: rest.slice(sectionEnd) };
}
