import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CONTEXT_DIR = resolve(import.meta.dirname, "../../context");
const MEMORY_DIR = resolve(CONTEXT_DIR, "memory");
const MEMORY_PATH = resolve(CONTEXT_DIR, "MEMORY.md");
const SOUL_PATH = resolve(CONTEXT_DIR, "SOUL.md");
const LESSONS_PATH = resolve(CONTEXT_DIR, "LESSONS.md");

// Size limits (in characters — zod .max() counts characters, not bytes)
const MAX_MEMORY_CHARS = 50_000;
const MAX_LESSONS_CHARS = 30_000;
const MAX_SOUL_LEARNED_CHARS = 10_000;
const MAX_ENTRY_CHARS = 2_000;
const MAX_DAILY_LOG_CHARS = 20_000;
const MAX_DAILY_LOG_AGE_DAYS = 7;

function ensureMemoryDir(): void {
	if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function readFileSafe(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf-8");
}

function createBackup(path: string): void {
	if (existsSync(path)) {
		writeFileSync(`${path}.bak`, readFileSync(path));
	}
}

function todayDateString(): string {
	const now = new Date();
	const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	return jst.toISOString().slice(0, 10);
}

function isDateWithinRange(dateStr: string): boolean {
	const target = new Date(`${dateStr}T00:00:00+09:00`);
	const now = new Date();
	const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	const today = new Date(`${jstNow.toISOString().slice(0, 10)}T00:00:00+09:00`);
	const diffDays = (today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24);
	return diffDays >= 0 && diffDays <= MAX_DAILY_LOG_AGE_DAYS;
}

function extractLearnedSection(content: string): {
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

const server = new McpServer({
	name: "memory",
	version: "0.1.0",
});

// --- read_memory ---
server.tool("read_memory", "MEMORY.md を読み取る", {}, () => {
	const content = readFileSafe(MEMORY_PATH);
	return {
		content: [{ type: "text", text: content || "(MEMORY.md は空です)" }],
	};
});

// --- update_memory ---
server.tool(
	"update_memory",
	"MEMORY.md を上書き更新する（バックアップ自動作成）",
	{
		content: z
			.string()
			.min(1)
			.max(MAX_MEMORY_CHARS)
			.describe("新しい MEMORY.md の内容（最大 50,000 文字）"),
	},
	({ content }) => {
		createBackup(MEMORY_PATH);
		writeFileSync(MEMORY_PATH, content, "utf-8");
		return {
			content: [
				{ type: "text", text: `MEMORY.md を更新しました（${String(content.length)} 文字）` },
			],
		};
	},
);

// --- read_soul ---
server.tool("read_soul", "SOUL.md を読み取る", {}, () => {
	const content = readFileSafe(SOUL_PATH);
	return {
		content: [{ type: "text", text: content || "(SOUL.md は空です)" }],
	};
});

// --- evolve_soul ---
server.tool(
	"evolve_soul",
	"SOUL.md の「学んだこと」セクションに追記する",
	{ entry: z.string().min(1).max(MAX_ENTRY_CHARS).describe("追記する内容（最大 2,000 文字）") },
	({ entry }) => {
		const content = readFileSafe(SOUL_PATH);
		const { before, section, after } = extractLearnedSection(content);

		if (!section) {
			return {
				content: [
					{ type: "text", text: "エラー: SOUL.md に「## 学んだこと」セクションが見つかりません" },
				],
			};
		}

		const newSection = `${section.trimEnd()}\n- ${entry}\n`;

		if (newSection.length > MAX_SOUL_LEARNED_CHARS) {
			return {
				content: [
					{
						type: "text",
						text: `エラー: 「学んだこと」セクションが上限（${String(MAX_SOUL_LEARNED_CHARS)}文字）を超えます`,
					},
				],
			};
		}

		const separator = after ? "\n" : "";
		const newContent = `${before}${newSection}${separator}${after}`;
		createBackup(SOUL_PATH);
		writeFileSync(SOUL_PATH, newContent, "utf-8");
		return {
			content: [{ type: "text", text: "SOUL.md の「学んだこと」に追記しました" }],
		};
	},
);

// --- append_daily_log ---
server.tool(
	"append_daily_log",
	"日次ログ (memory/YYYY-MM-DD.md) に追記する",
	{
		entry: z.string().min(1).max(MAX_ENTRY_CHARS).describe("追記する内容（最大 2,000 文字）"),
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.optional()
			.describe("日付（YYYY-MM-DD、デフォルト: 今日）"),
	},
	({ entry, date }) => {
		const targetDate = date ?? todayDateString();

		if (!isDateWithinRange(targetDate)) {
			return {
				content: [
					{ type: "text", text: `エラー: ${targetDate} は許可範囲外です（過去7日以内のみ）` },
				],
			};
		}

		ensureMemoryDir();
		const logPath = resolve(MEMORY_DIR, `${targetDate}.md`);
		const existing = readFileSafe(logPath);

		// overhead: "\n- [HH:MM:SS] " (16 chars) + "\n" (1 char) + header "# YYYY-MM-DD\n" (13 chars if new)
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
			content: [{ type: "text", text: `${targetDate} のログに追記しました` }],
		};
	},
);

// --- read_daily_log ---
server.tool(
	"read_daily_log",
	"日次ログを読み取る",
	{
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.optional()
			.describe("日付（YYYY-MM-DD、デフォルト: 今日）"),
	},
	({ date }) => {
		const targetDate = date ?? todayDateString();
		const logPath = resolve(MEMORY_DIR, `${targetDate}.md`);
		const content = readFileSafe(logPath);
		return {
			content: [{ type: "text", text: content || `(${targetDate} のログはありません)` }],
		};
	},
);

// --- list_daily_logs ---
server.tool(
	"list_daily_logs",
	"日次ログ一覧を表示する",
	{ limit: z.number().min(1).max(30).optional().describe("表示件数（デフォルト: 7）") },
	({ limit }) => {
		ensureMemoryDir();
		const maxItems = limit ?? 7;
		const files = readdirSync(MEMORY_DIR)
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
			.toSorted()
			.toReversed()
			.slice(0, maxItems);

		if (files.length === 0) {
			return { content: [{ type: "text", text: "日次ログはありません" }] };
		}

		const lines = files.map((f) => {
			const path = resolve(MEMORY_DIR, f);
			const size = readFileSync(path).length;
			return `- ${f.replace(".md", "")} (${String(size)} bytes)`;
		});
		return { content: [{ type: "text", text: lines.join("\n") }] };
	},
);

// --- read_lessons ---
server.tool("read_lessons", "LESSONS.md を読み取る", {}, () => {
	const content = readFileSafe(LESSONS_PATH);
	return {
		content: [{ type: "text", text: content || "(LESSONS.md は空です)" }],
	};
});

// --- update_lessons ---
server.tool(
	"update_lessons",
	"LESSONS.md を上書き更新する（バックアップ自動作成）",
	{
		content: z
			.string()
			.min(1)
			.max(MAX_LESSONS_CHARS)
			.describe("新しい LESSONS.md の内容（最大 30,000 文字）"),
	},
	({ content }) => {
		createBackup(LESSONS_PATH);
		writeFileSync(LESSONS_PATH, content, "utf-8");
		return {
			content: [
				{ type: "text", text: `LESSONS.md を更新しました（${String(content.length)} 文字）` },
			],
		};
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
