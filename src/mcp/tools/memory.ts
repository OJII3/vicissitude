import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import path, { resolve } from "path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	BASE_CONTEXT_DIR,
	MAX_DAILY_LOG_AGE_DAYS,
	MAX_DAILY_LOG_CHARS,
	MAX_ENTRY_CHARS,
	MAX_LESSONS_CHARS,
	MAX_MEMORY_CHARS,
	OVERLAY_CONTEXT_DIR,
	SOUL_PATH,
	createBackup,
	ensureDir,
	guildIdSchema,
	guildLabel,
	isDateWithinRange,
	readWithFallback,
	resolveContextPaths,
	todayDateString,
} from "../memory-helpers.ts";

export function registerMemoryTools(server: McpServer): void {
	server.tool(
		"read_memory",
		"MEMORY.md を読み取る（guild_id 指定時は Guild 固有のメモリ）",
		{ guild_id: guildIdSchema },
		({ guild_id }) => {
			const { memoryPath } = resolveContextPaths(guild_id);
			const content = readWithFallback(memoryPath);
			return {
				content: [{ type: "text", text: content || `${guildLabel(guild_id)}(MEMORY.md は空です)` }],
			};
		},
	);

	server.tool(
		"update_memory",
		"MEMORY.md を上書き更新する（.bak バックアップ自動作成、guild_id 指定時は Guild 固有。運用設定・行動ルール・週次目標が対象、ユーザー背景情報は LTM に委譲）",
		{
			content: z
				.string()
				.min(1)
				.max(MAX_MEMORY_CHARS)
				.describe("新しい MEMORY.md の内容（最大 50,000 文字）"),
			guild_id: guildIdSchema,
		},
		({ content, guild_id }) => {
			const { memoryPath } = resolveContextPaths(guild_id);
			ensureDir(resolve(memoryPath, ".."));
			createBackup(memoryPath);
			writeFileSync(memoryPath, content, "utf-8");
			return {
				content: [
					{
						type: "text",
						text: `${guildLabel(guild_id)}MEMORY.md を更新しました（${String(content.length)} 文字）`,
					},
				],
			};
		},
	);

	server.tool("read_soul", "SOUL.md を読み取る", {}, () => {
		const content = readWithFallback(SOUL_PATH);
		return {
			content: [{ type: "text", text: content || "(SOUL.md は空です)" }],
		};
	});

	server.tool(
		"append_daily_log",
		"日次ログに追記する（heartbeat 実行記録・自省メモ専用。会話まとめは LTM に自動記録されるため不要。guild_id 指定時は Guild 固有）",
		{
			entry: z.string().min(1).max(MAX_ENTRY_CHARS).describe("追記する内容（最大 2,000 文字）"),
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional()
				.describe("日付（YYYY-MM-DD、デフォルト: 今日）"),
			guild_id: guildIdSchema,
		},
		({ entry, date, guild_id }) => {
			const targetDate = date ?? todayDateString();

			if (!isDateWithinRange(targetDate)) {
				return {
					content: [
						{
							type: "text",
							text: `エラー: ${targetDate} は許可範囲外です（過去7日以内のみ）`,
						},
					],
				};
			}

			const { memoryDir } = resolveContextPaths(guild_id);
			ensureDir(memoryDir);
			const logPath = resolve(memoryDir, `${targetDate}.md`);
			const existing = readWithFallback(logPath);

			// overhead: existing ? "\n- [HH:MM:SS] " (17 chars) : "# YYYY-MM-DD\n\n- [HH:MM:SS] " (30 chars)
			const overhead = existing ? 17 : 30;
			if (existing.length + entry.length + overhead > MAX_DAILY_LOG_CHARS) {
				return {
					content: [
						{
							type: "text",
							text: `エラー: ${targetDate} のログが上限（${String(MAX_DAILY_LOG_CHARS)}文字）を超えます`,
						},
					],
				};
			}

			const timestamp = new Date().toLocaleTimeString("ja-JP", {
				timeZone: "Asia/Tokyo",
				hour12: false,
			});
			const logEntry = `\n- [${timestamp}] ${entry}\n`;

			if (existing) {
				writeFileSync(logPath, existing + logEntry, "utf-8");
			} else {
				writeFileSync(logPath, `# ${targetDate}\n${logEntry}`, "utf-8");
			}

			return {
				content: [
					{
						type: "text",
						text: `${guildLabel(guild_id)}${targetDate} のログに追記しました`,
					},
				],
			};
		},
	);

	server.tool(
		"read_daily_log",
		"日次ログを読み取る（guild_id 指定時は Guild 固有）",
		{
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional()
				.describe("日付（YYYY-MM-DD、デフォルト: 今日）"),
			guild_id: guildIdSchema,
		},
		({ date, guild_id }) => {
			const targetDate = date ?? todayDateString();
			const { memoryDir } = resolveContextPaths(guild_id);
			const logPath = resolve(memoryDir, `${targetDate}.md`);
			const content = readWithFallback(logPath);
			return {
				content: [
					{
						type: "text",
						text: content || `${guildLabel(guild_id)}(${targetDate} のログはありません)`,
					},
				],
			};
		},
	);

	server.tool(
		"list_daily_logs",
		"日次ログ一覧を表示する（guild_id 指定時は Guild 固有）",
		{
			limit: z.number().min(1).max(30).optional().describe("表示件数（デフォルト: 7）"),
			guild_id: guildIdSchema,
		},
		({ limit, guild_id }) => {
			const { memoryDir } = resolveContextPaths(guild_id);
			ensureDir(memoryDir);

			const overlayRelative = path.relative(OVERLAY_CONTEXT_DIR, memoryDir);
			const baseMemoryDir = resolve(BASE_CONTEXT_DIR, overlayRelative);

			const maxItems = limit ?? 7;
			const overlayFiles = readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
			const baseFiles = existsSync(baseMemoryDir)
				? readdirSync(baseMemoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
				: [];
			const mergedFiles = [...new Set([...overlayFiles, ...baseFiles])]
				.toSorted()
				.toReversed()
				.slice(0, maxItems);

			if (mergedFiles.length === 0) {
				return {
					content: [{ type: "text", text: `${guildLabel(guild_id)}日次ログはありません` }],
				};
			}

			const lines = mergedFiles.map((f) => {
				const overlayPath = resolve(memoryDir, f);
				const basePath = resolve(baseMemoryDir, f);
				const filePath = existsSync(overlayPath) ? overlayPath : basePath;
				const size = statSync(filePath).size;
				return `- ${f.replace(".md", "")} (${String(size)} bytes)`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	);

	server.tool(
		"read_lessons",
		"LESSONS.md を読み取る（guild_id 指定時は Guild 固有）",
		{ guild_id: guildIdSchema },
		({ guild_id }) => {
			const { lessonsPath } = resolveContextPaths(guild_id);
			const content = readWithFallback(lessonsPath);
			return {
				content: [
					{
						type: "text",
						text: content || `${guildLabel(guild_id)}(LESSONS.md は空です)`,
					},
				],
			};
		},
	);

	server.tool(
		"update_lessons",
		"LESSONS.md を上書き更新する（更新前に ltm_get_facts で guideline カテゴリを確認し重複を避ける。バックアップ自動作成、guild_id 指定時は Guild 固有）",
		{
			content: z
				.string()
				.min(1)
				.max(MAX_LESSONS_CHARS)
				.describe("新しい LESSONS.md の内容（最大 30,000 文字）"),
			guild_id: guildIdSchema,
		},
		({ content, guild_id }) => {
			const { lessonsPath } = resolveContextPaths(guild_id);
			ensureDir(resolve(lessonsPath, ".."));
			createBackup(lessonsPath);
			writeFileSync(lessonsPath, content, "utf-8");
			return {
				content: [
					{
						type: "text",
						text: `${guildLabel(guild_id)}LESSONS.md を更新しました（${String(content.length)} 文字）`,
					},
				],
			};
		},
	);

	server.tool(
		"cleanup_old_logs",
		`${String(MAX_DAILY_LOG_AGE_DAYS)} 日より古い日次ログを削除する（guild_id 指定時は Guild 固有、overlay のみ対象）`,
		{ guild_id: guildIdSchema },
		({ guild_id }) => {
			const { memoryDir } = resolveContextPaths(guild_id);
			if (!existsSync(memoryDir)) {
				return {
					content: [
						{ type: "text", text: `${guildLabel(guild_id)}日次ログディレクトリが存在しません` },
					],
				};
			}

			const files = readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
			const removed: string[] = [];
			for (const file of files) {
				const dateStr = file.replace(".md", "");
				// 未来日は保持し、7日超過の過去日のみ削除
				if (!isDateWithinRange(dateStr) && dateStr <= todayDateString()) {
					unlinkSync(resolve(memoryDir, file));
					removed.push(dateStr);
				}
			}

			if (removed.length === 0) {
				return {
					content: [
						{ type: "text", text: `${guildLabel(guild_id)}削除対象の古いログはありません` },
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `${guildLabel(guild_id)}${String(removed.length)} 件の古いログを削除しました: ${removed.join(", ")}`,
					},
				],
			};
		},
	);
}
