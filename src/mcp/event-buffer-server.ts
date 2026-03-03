import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { resolve as resolvePath } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const root = resolvePath(import.meta.dirname, "../..");
const bufferDir = process.env.EVENT_BUFFER_DIR ?? resolvePath(root, "data/event-buffer");
const bufferFile = resolvePath(bufferDir, "events.jsonl");

if (!existsSync(bufferDir)) {
	mkdirSync(bufferDir, { recursive: true });
}

/** バッファファイルをアトミックに消費して JSON 配列文字列を返す。イベントなしなら null。 */
function consumeBuffer(): string | null {
	if (!existsSync(bufferFile)) return null;

	const tmpFile = `${bufferFile}.reading.${Date.now()}`;
	try {
		renameSync(bufferFile, tmpFile);
	} catch {
		return null;
	}

	const raw = readFileSync(tmpFile, "utf-8");
	unlinkSync(tmpFile);

	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) return null;

	const events: unknown[] = [];
	for (const line of lines) {
		try {
			events.push(JSON.parse(line));
		} catch {
			// 破損行はスキップ（部分書き込み等）
		}
	}
	if (events.length === 0) return null;
	return JSON.stringify(events, null, 2);
}

const server = new McpServer({
	name: "event-buffer",
	version: "1.0.0",
});

server.tool(
	"wait_for_events",
	"イベントが届くまで待機し、届いたら消費して返す。タイムアウト時は空配列を返す。",
	{ timeout_seconds: z.number().min(1).max(120).default(60) },
	async ({ timeout_seconds }) => {
		// 既にバッファにイベントがあれば即返却
		const immediate = consumeBuffer();
		if (immediate) {
			return { content: [{ type: "text" as const, text: immediate }] };
		}

		// 1 秒間隔でポーリング
		const deadline = Date.now() + timeout_seconds * 1000;
		while (Date.now() < deadline) {
			// eslint-disable-next-line no-await-in-loop -- intentional sequential polling
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 1000);
			});

			const result = consumeBuffer();
			if (result) {
				return { content: [{ type: "text" as const, text: result }] };
			}
		}

		return { content: [{ type: "text" as const, text: "[]" }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
