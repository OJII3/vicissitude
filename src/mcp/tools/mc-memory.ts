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

const GOALS_FILENAME = "MINECRAFT-GOALS.md";
const SKILLS_FILENAME = "MINECRAFT-SKILLS.md";

export interface McMemoryDeps {
	dataDir: string;
}

/** @internal テスト用にもエクスポート */
export function baseMinecraftDir(): string {
	return resolve(BASE_CONTEXT_DIR, "minecraft");
}

/** @internal テスト用にもエクスポート */
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

export function registerMcMemoryTools(server: McpServer, deps: McMemoryDeps): void {
	const { dataDir } = deps;

	// --- Goals / Progress (shared handlers) ---

	const readGoalsHandler = () => {
		const content = readOverlay(dataDir, GOALS_FILENAME);
		return {
			content: [{ type: "text" as const, text: content || "(目標ファイルは空です)" }],
		};
	};

	const updateGoalsSchema = {
		content: z
			.string()
			.min(1)
			.max(MAX_GOALS_CHARS)
			.describe("新しい MINECRAFT-GOALS.md の内容（最大 20,000 文字）"),
	};

	const updateGoalsHandler = ({ content }: { content: string }) => {
		writeOverlay(dataDir, GOALS_FILENAME, content);
		return {
			content: [
				{
					type: "text" as const,
					text: `MINECRAFT-GOALS.md を更新しました（${String(content.length)} 文字）`,
				},
			],
		};
	};

	server.tool("mc_read_goals", "Minecraft 目標ファイルを読む", {}, readGoalsHandler);

	server.tool(
		"mc_update_goals",
		"Minecraft 目標ファイルを上書き更新する（バックアップ自動作成）",
		updateGoalsSchema,
		updateGoalsHandler,
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
		"Minecraft スキルライブラリにスキルを追記する",
		{
			name: z.string().min(1).max(200).describe("スキル名"),
			description: z.string().min(1).max(2_000).describe("スキルの説明・手順"),
		},
		({ name, description }) => {
			const existing = readOverlay(dataDir, SKILLS_FILENAME);
			const safeName = name.replaceAll(/[\r\n]/g, " ");
			const safeDescription = description.replaceAll(/^#{1,6}\s/gm, "");
			const entry = `\n## ${safeName}\n\n${safeDescription}\n`;
			const updated = existing ? existing + entry : `# Minecraft スキルライブラリ\n${entry}`;
			writeOverlay(dataDir, SKILLS_FILENAME, updated);
			return {
				content: [{ type: "text" as const, text: `スキル「${name}」を記録しました` }],
			};
		},
	);

	// --- Progress (aliases for Goals) ---

	server.tool(
		"mc_read_progress",
		"Minecraft 目標の進捗を読む（mc_read_goals のエイリアス）",
		{},
		readGoalsHandler,
	);

	server.tool(
		"mc_update_progress",
		"Minecraft 目標の進捗を更新する（mc_update_goals のエイリアス、バックアップ自動作成）",
		updateGoalsSchema,
		updateGoalsHandler,
	);
}
