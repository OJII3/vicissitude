import { afterAll, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer } from "@vicissitude/mcp/http-server";
import { parseMcpResponse } from "@vicissitude/mcp/test-helpers";
import { registerDiscordBridgeTools } from "@vicissitude/mcp/tools/mc-bridge-discord";
import type { Logger } from "@vicissitude/shared/types";
import { tryAcquireSessionLock, setMcConnectionStatus } from "@vicissitude/store/mc-bridge";
import { createTestDb } from "@vicissitude/store/test-helpers";

const stubLogger: Logger = { info() {}, warn() {}, error() {} };

let baseUrl: string;

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
	return parseMcpResponse(res) as Promise<ToolResult>;
}

describe("MCP HTTP + mc-bridge ツール結合テスト", () => {
	const db = createTestDb();

	function createTestMcpServer(): McpServer {
		const server = new McpServer({ name: "test-mc-bridge", version: "0.1.0" });
		registerDiscordBridgeTools(server, { db });
		return server;
	}

	const { port, cleanupTimer, closeAllSessions, stopServer } = startHttpServer(
		createTestMcpServer,
		0,
		"test-mc-bridge",
		stubLogger,
	);
	baseUrl = `http://localhost:${port}`;

	afterAll(() => {
		clearInterval(cleanupTimer);
		closeAllSessions();
		stopServer();
	});

	test("health check → セッション作成 → minecraft_delegate 実行で event_buffer にイベントが入る", async () => {
		// health check
		const healthRes = await fetch(`${baseUrl}/health`);
		expect(healthRes.status).toBe(200);

		// セッション作成 + ツール呼び出し
		const sessionId = await initSession();
		const result = await callTool(sessionId, "minecraft_delegate", { command: "石を掘って" });

		expect(result.result).toBeDefined();
		expect(result.result?.content.at(0)?.text).toContain("指示を出した");
	});

	test("minecraft_status が接続状態を返す", async () => {
		// ロック取得 + 接続状態設定
		tryAcquireSessionLock(db, "guild-1");
		setMcConnectionStatus(db, true);

		const sessionId = await initSession();
		const result = await callTool(sessionId, "minecraft_status", {});

		expect(result.result).toBeDefined();
		const text = result.result?.content.at(0)?.text ?? "";
		expect(text).toContain("接続中");
	});
});
