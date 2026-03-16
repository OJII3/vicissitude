import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path, { resolve } from "path";

import { z } from "zod";

const root = process.env.APP_ROOT ?? resolve(import.meta.dirname, "../..");
export const BASE_CONTEXT_DIR = resolve(root, "context");
export const OVERLAY_CONTEXT_DIR = resolve(root, "data/context");
export const SOUL_PATH = resolve(OVERLAY_CONTEXT_DIR, "SOUL.md");

export const MAX_MEMORY_CHARS = 50_000;
export const MAX_LESSONS_CHARS = 30_000;

const GUILD_ID_REGEX = /^\d+$/;

export const guildIdSchema = z
	.string()
	.regex(GUILD_ID_REGEX, "guild_id は Discord snowflake（数字のみ）である必要があります")
	.optional()
	.describe("Guild ID（指定時は Guild 固有のメモリを使用、省略時はグローバル）");

export interface ContextPaths {
	memoryPath: string;
	lessonsPath: string;
}

export function resolveContextPaths(guildId?: string): ContextPaths {
	if (guildId) {
		const guildDir = resolve(OVERLAY_CONTEXT_DIR, "guilds", guildId);
		return {
			memoryPath: resolve(guildDir, "MEMORY.md"),
			lessonsPath: resolve(guildDir, "LESSONS.md"),
		};
	}
	return {
		memoryPath: resolve(OVERLAY_CONTEXT_DIR, "MEMORY.md"),
		lessonsPath: resolve(OVERLAY_CONTEXT_DIR, "LESSONS.md"),
	};
}

export function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readFileSafe(filePath: string): string {
	if (!existsSync(filePath)) return "";
	return readFileSync(filePath, "utf-8");
}

/** overlay → base のフォールバック読み込み（任意のディレクトリペアを指定可能） */
export function readWithFallbackFrom(
	overlayPath: string,
	overlayDir: string,
	baseDir: string,
): string {
	if (existsSync(overlayPath)) return readFileSync(overlayPath, "utf-8");
	const relative = path.relative(overlayDir, overlayPath);
	return readFileSafe(resolve(baseDir, relative));
}

/** overlay → base のフォールバック読み込み（デフォルトディレクトリ使用） */
export function readWithFallback(overlayPath: string): string {
	return readWithFallbackFrom(overlayPath, OVERLAY_CONTEXT_DIR, BASE_CONTEXT_DIR);
}

export function createBackup(filePath: string): void {
	if (existsSync(filePath)) {
		writeFileSync(`${filePath}.bak`, readFileSync(filePath));
	}
}

export function guildLabel(guildId?: string): string {
	return guildId ? `[guild:${guildId}] ` : "";
}
