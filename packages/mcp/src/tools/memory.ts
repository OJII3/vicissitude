import { writeFileSync } from "fs";
import { resolve } from "path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
	MAX_LESSONS_CHARS,
	MAX_MEMORY_CHARS,
	SOUL_PATH,
	createBackup,
	ensureDir,
	guildIdSchema,
	guildLabel,
	readWithFallback,
	resolveContextPaths,
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
}
