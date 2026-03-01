import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { resolve as resolvePath } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const root = resolvePath(import.meta.dirname, "../..");
const bufferDir = resolvePath(root, "data/event-buffer");
const bufferFile = resolvePath(bufferDir, "events.jsonl");

if (!existsSync(bufferDir)) {
	mkdirSync(bufferDir, { recursive: true });
}

const server = new McpServer({
	name: "event-buffer",
	version: "1.0.0",
});

server.tool(
	"read_events",
	"バッファの全イベントを読み取り、ファイルをクリアして返す（消費型）",
	{},
	() => {
		if (!existsSync(bufferFile)) {
			return { content: [{ type: "text" as const, text: "[]" }] };
		}

		// アトミックなリネームで TOCTOU を回避
		const tmpFile = `${bufferFile}.reading.${Date.now()}`;
		try {
			renameSync(bufferFile, tmpFile);
		} catch {
			// リネーム失敗 = ファイルが存在しない（別の read_events が先に処理した）
			return { content: [{ type: "text" as const, text: "[]" }] };
		}

		const raw = readFileSync(tmpFile, "utf-8");
		unlinkSync(tmpFile);

		const lines = raw.split("\n").filter((line) => line.trim() !== "");

		if (lines.length === 0) {
			return { content: [{ type: "text" as const, text: "[]" }] };
		}

		const events = lines.map((line) => JSON.parse(line));
		return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] };
	},
);

server.tool("event_count", "未消費イベント数を返す", {}, () => {
	if (!existsSync(bufferFile)) {
		return { content: [{ type: "text" as const, text: "0" }] };
	}

	try {
		const raw = readFileSync(bufferFile, "utf-8");
		const count = raw.split("\n").filter((line) => line.trim() !== "").length;
		return { content: [{ type: "text" as const, text: String(count) }] };
	} catch {
		return { content: [{ type: "text" as const, text: "0" }] };
	}
});

server.tool(
	"wait",
	"指定秒数待機する",
	{ seconds: z.number().min(1).max(60) },
	async ({ seconds }) => {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, seconds * 1000);
		});
		return { content: [{ type: "text", text: `${seconds}秒待機しました` }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
