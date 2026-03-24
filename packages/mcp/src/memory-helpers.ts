import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path, { resolve } from "path";

import { APP_ROOT } from "@vicissitude/shared/config";

const root = APP_ROOT;
export const BASE_CONTEXT_DIR = resolve(root, "context");
export const OVERLAY_CONTEXT_DIR = resolve(root, "data/context");

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

export function createBackup(filePath: string): void {
	if (existsSync(filePath)) {
		writeFileSync(`${filePath}.bak`, readFileSync(filePath));
	}
}
