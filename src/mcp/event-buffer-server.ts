import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const root = resolve(import.meta.dirname, "../..");
const bufferDir = resolve(root, "data/event-buffer");
const bufferFile = resolve(bufferDir, "events.jsonl");

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
	async () => {
		const file = Bun.file(bufferFile);
		if (!(await file.exists())) {
			return { content: [{ type: "text", text: "[]" }] };
		}

		const raw = await file.text();
		// クリア（消費型）
		await Bun.write(bufferFile, "");

		const lines = raw.split("\n").filter((line) => line.trim() !== "");

		if (lines.length === 0) {
			return { content: [{ type: "text", text: "[]" }] };
		}

		const events = lines.map((line) => JSON.parse(line));
		return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
	},
);

server.tool("event_count", "未消費イベント数を返す", {}, async () => {
	const file = Bun.file(bufferFile);
	if (!(await file.exists())) {
		return { content: [{ type: "text", text: "0" }] };
	}

	const raw = await file.text();
	const count = raw.split("\n").filter((line) => line.trim() !== "").length;

	return { content: [{ type: "text", text: String(count) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
