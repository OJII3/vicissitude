import { writeFileSync } from "fs";
import { resolve } from "path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	BASE_CONTEXT_DIR,
	createBackup,
	ensureDir,
	readWithFallbackFrom,
} from "../memory-helpers.ts";

const MAX_GOALS_CHARS = 20_000;
const MAX_PROGRESS_CHARS = 20_000;
const MAX_SKILLS_CHARS = 50_000;

const GOALS_FILENAME = "MINECRAFT-GOALS.md";
const PROGRESS_FILENAME = "MINECRAFT-PROGRESS.md";
const SKILLS_FILENAME = "MINECRAFT-SKILLS.md";

export interface McMemoryDeps {
	dataDir: string;
}

/** @internal テスト用にもエクスポート */
export function baseMinecraftDir(): string {
	return resolve(BASE_CONTEXT_DIR, "minecraft");
}

/**
 * dataDir → context/minecraft/ のフォールバック読み込み。
 * dataDir 内のファイルを優先し、なければ base（context/minecraft/）から読む。
 * @internal テスト用にもエクスポート
 */
export function readOverlay(dataDir: string, filename: string): string {
	const overlayPath = resolve(dataDir, filename);
	return readWithFallbackFrom(overlayPath, dataDir, baseMinecraftDir());
}

/** @internal テスト用にもエクスポート */
export function writeOverlay(dataDir: string, filename: string, content: string): void {
	ensureDir(dataDir);
	const overlayPath = resolve(dataDir, filename);
	createBackup(overlayPath);
	writeFileSync(overlayPath, content, "utf-8");
}

/** スキル名のサニタイズ（改行と # を除去） */
export function sanitizeSkillName(name: string): string {
	return name.replaceAll(/[\r\n#]/g, " ").trim();
}

/** スキル説明のサニタイズ（Markdown ヘッダーを除去） */
export function sanitizeSkillDescription(description: string): string {
	return description.replaceAll(/^#{1,6}\s/gm, "");
}

/** 単一行テキストのサニタイズ（改行・Markdown ヘッダーを除去） */
export function sanitizeSingleLine(text: string): string {
	return sanitizeSkillDescription(text).replaceAll(/[\r\n]+/g, " ").trim();
}

export function registerMcMemoryTools(server: McpServer, deps: McMemoryDeps): void {
	const { dataDir } = deps;

	// --- Goals ---

	server.tool("mc_read_goals", "Minecraft 目標ファイルを読む（現在の目標のみ）", {}, () => {
		const content = readOverlay(dataDir, GOALS_FILENAME);
		return {
			content: [{ type: "text" as const, text: content || "(目標ファイルは空です)" }],
		};
	});

	server.tool(
		"mc_update_goals",
		"Minecraft 目標ファイルを上書き更新する（バックアップ自動作成）。現在の目標のみ記載すること。達成済み目標や探索メモは mc_update_progress に記録する。",
		{
			content: z
				.string()
				.min(1)
				.max(MAX_GOALS_CHARS)
				.describe("新しい MINECRAFT-GOALS.md の内容（最大 20,000 文字）"),
		},
		({ content }) => {
			writeOverlay(dataDir, GOALS_FILENAME, content);
			return {
				content: [
					{
						type: "text" as const,
						text: `MINECRAFT-GOALS.md を更新しました（${String(content.length)} 文字）`,
					},
				],
			};
		},
	);

	// --- Progress ---

	server.tool(
		"mc_read_progress",
		"Minecraft ワールド進捗を読む（装備段階、拠点、探索範囲、主要資源、達成済み目標、プレイヤーメモ）",
		{},
		() => {
			const content = readOverlay(dataDir, PROGRESS_FILENAME);
			return {
				content: [{ type: "text" as const, text: content || "(進捗ファイルは空です)" }],
			};
		},
	);

	server.tool(
		"mc_update_progress",
		"Minecraft ワールド進捗を更新する（バックアップ自動作成）。装備段階、拠点、探索範囲、主要資源、達成済み目標、プレイヤーメモを記録する。",
		{
			content: z
				.string()
				.min(1)
				.max(MAX_PROGRESS_CHARS)
				.describe("新しい MINECRAFT-PROGRESS.md の内容（最大 20,000 文字）"),
		},
		({ content }) => {
			writeOverlay(dataDir, PROGRESS_FILENAME, content);
			return {
				content: [
					{
						type: "text" as const,
						text: `MINECRAFT-PROGRESS.md を更新しました（${String(content.length)} 文字）`,
					},
				],
			};
		},
	);

	// --- Skills ---

	server.tool("mc_read_skills", "Minecraft スキルライブラリを読む", {}, () => {
		const content = readOverlay(dataDir, SKILLS_FILENAME);
		return {
			content: [{ type: "text" as const, text: content || "(スキルライブラリは空です)" }],
		};
	});

	server.tool(
		"mc_record_skill",
		"Minecraft スキルライブラリにスキルを追記する（有効条件・前提装備・失敗パターン付き）",
		{
			name: z.string().min(1).max(200).describe("スキル名"),
			description: z.string().min(1).max(2_000).describe("スキルの説明・手順"),
			preconditions: z
				.string()
				.max(500)
				.optional()
				.describe("有効条件・前提装備（例: 石のピッケル以上が必要）"),
			failure_patterns: z
				.string()
				.max(500)
				.optional()
				.describe("既知の失敗パターン（例: 夜間は敵mobで中断されやすい）"),
		},
		({ name, description, preconditions, failure_patterns }) => {
			const existing = readOverlay(dataDir, SKILLS_FILENAME);
			const safeName = sanitizeSkillName(name);
			const safeDescription = sanitizeSkillDescription(description);

			const lines = [`\n## ${safeName}\n\n${safeDescription}`];
			if (preconditions) {
				lines.push(`\n**前提条件**: ${sanitizeSingleLine(preconditions)}`);
			}
			if (failure_patterns) {
				lines.push(`\n**失敗パターン**: ${sanitizeSingleLine(failure_patterns)}`);
			}

			const entry = `${lines.join("")}\n`;
			const updated = existing ? existing + entry : `# Minecraft スキルライブラリ\n${entry}`;
			if (updated.length > MAX_SKILLS_CHARS) {
				return {
					content: [
						{
							type: "text" as const,
							text: `スキルライブラリのサイズ上限（${String(MAX_SKILLS_CHARS)} 文字）に達しました。不要なスキルを整理してください。`,
						},
					],
				};
			}
			writeOverlay(dataDir, SKILLS_FILENAME, updated);
			return {
				content: [{ type: "text" as const, text: `スキル「${name}」を記録しました` }],
			};
		},
	);
}
