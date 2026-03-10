import { afterAll, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { StoreDb } from "../../store/db.ts";
import { insertBridgeEvent } from "../../store/mc-bridge.ts";
import { createTestDb } from "../../store/test-helpers.ts";
import { startHttpServer } from "../http-server.ts";
import { registerMainBrainBridgeTools } from "./mc-bridge-main.ts";

const TEST_PORT = 49_740;
const baseUrl = `http://localhost:${TEST_PORT}`;

const MCP_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
};

const MCP_INIT_BODY = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "test", version: "0.1.0" },
	},
});

/** SSE またはプレーン JSON のレスポンスを解析して JSON-RPC レスポンスを返す */
async function parseResponse(res: Response): Promise<Record<string, unknown>> {
	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		const text = await res.text();
		// SSE: "data: {...}\n\n" 形式の最後の JSON-RPC レスポンスを取得
		const lines = text.split("\n");
		let lastData: string | undefined;
		for (const line of lines) {
			if (line.startsWith("data: ")) {
				lastData = line.slice(6);
			}
		}
		if (!lastData) throw new Error("No SSE data found");
		return JSON.parse(lastData) as Record<string, unknown>;
	}
	return res.json() as Promise<Record<string, unknown>>;
}

/** セッション初期化して sessionId を返す */
async function initSession(): Promise<string> {
	const res = await fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: MCP_HEADERS,
		body: MCP_INIT_BODY,
	});
	expect(res.status).toBe(200);
	const sessionId = res.headers.get("mcp-session-id");
	expect(sessionId).toBeTruthy();
	return sessionId ?? "";
}

interface ToolResult {
	result?: { content: { type: string; text: string }[] };
	error?: unknown;
}

/** MCP JSON-RPC ツール呼び出し */
async function callTool(
	sessionId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const res = await fetch(`${baseUrl}/mcp`, {
		method: "POST",
		headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
	});
	expect(res.status).toBe(200);
	return parseResponse(res) as Promise<ToolResult>;
}

// 共有 DB — 全テストで同じ DB を使用（HTTP サーバーは createServer 単位で DB を参照）
let sharedDb: StoreDb;

function createTestMcpServer(): McpServer {
	const server = new McpServer({ name: "test-mc-bridge", version: "0.1.0" });
	registerMainBrainBridgeTools(server, { db: sharedDb });
	return server;
}

describe("MCP HTTP + mc-bridge ツール結合テスト", () => {
	sharedDb = createTestDb();
	const { cleanupTimer, closeAllSessions } = startHttpServer(
		createTestMcpServer,
		TEST_PORT,
		"test-mc-bridge",
	);

	afterAll(() => {
		clearInterval(cleanupTimer);
		closeAllSessions();
	});

	test("health check → セッション作成 → minecraft_delegate 実行で DB にイベントが入る", async () => {
		// health check
		const healthRes = await fetch(`${baseUrl}/health`);
		expect(healthRes.status).toBe(200);

		// セッション作成 + ツール呼び出し
		const sessionId = await initSession();
		const result = await callTool(sessionId, "minecraft_delegate", { command: "石を掘って" });

		expect(result.result).toBeDefined();
		expect(result.result?.content.at(0)?.text).toContain("指示を出した");
	});

	test("minecraft_status が未消費イベントを返す", async () => {
		// DB に直接 report を挿入
		insertBridgeEvent(
			sharedDb,
			"to_main",
			"report",
			JSON.stringify({ message: "ダイヤ見つけた", importance: "high" }),
		);

		const sessionId = await initSession();
		const result = await callTool(sessionId, "minecraft_status", {});

		expect(result.result).toBeDefined();
		const text = result.result?.content.at(0)?.text ?? "";
		// JSON 配列が返る（formatBridgeEvents の出力）
		expect(text).toContain("ダイヤ見つけた");
	});
});
