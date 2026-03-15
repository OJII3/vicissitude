import { afterAll, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { startHttpServer } from "../../../src/mcp/minecraft/http-server.ts";

// テスト用ポート（他と競合しない高ポート）
const TEST_PORT = 49_731;
const TEST_PORT_ERROR = 49_732;

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

const MCP_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
};

function createTestServer(): McpServer {
	return new McpServer({ name: "test", version: "0.1.0" });
}

describe("MCP HTTP Server ライフサイクル", () => {
	const { cleanupTimer, closeAllSessions, stopServer } = startHttpServer(
		createTestServer,
		TEST_PORT,
	);
	const baseUrl = `http://localhost:${TEST_PORT}`;

	afterAll(() => {
		clearInterval(cleanupTimer);
		closeAllSessions();
		stopServer();
	});

	describe("GET /health — readiness check", () => {
		test("200 OK を返す", async () => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.status).toBe(200);
		});

		test('レスポンスボディが { status: "ok" }', async () => {
			const res = await fetch(`${baseUrl}/health`);
			const body = await res.json();
			expect(body).toEqual({ status: "ok" });
		});

		test("Content-Type が application/json", async () => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.headers.get("content-type")).toBe("application/json");
		});
	});

	describe("ルーティング", () => {
		test("未知のパスは 404 を返す", async () => {
			const res = await fetch(`${baseUrl}/unknown`);
			expect(res.status).toBe(404);
		});

		test("GET /mcp はセッション無しで 400 を返す", async () => {
			const res = await fetch(`${baseUrl}/mcp`);
			expect(res.status).toBe(400);
		});

		test("POST /mcp はセッション無しで新規セッションを作成する", async () => {
			const res = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: MCP_HEADERS,
				body: MCP_INIT_BODY,
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("mcp-session-id")).toBeTruthy();
		});
	});

	describe("セッション再利用", () => {
		test("セッション ID 付きリクエストで既存セッションが再利用される", async () => {
			// セッション作成
			const initRes = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: MCP_HEADERS,
				body: MCP_INIT_BODY,
			});
			const sessionId = initRes.headers.get("mcp-session-id");
			expect(sessionId).toBeTruthy();

			// 同じセッション ID でリクエスト
			const res = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { ...MCP_HEADERS, "mcp-session-id": sessionId ?? "" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
				}),
			});
			expect(res.status).toBe(200);
		});

		test("存在しないセッション ID は 404 を返す", async () => {
			const res = await fetch(`${baseUrl}/mcp`, {
				method: "GET",
				headers: { "mcp-session-id": "nonexistent-session-id" },
			});
			expect(res.status).toBe(404);
		});
	});
});

function createFailingServer(): McpServer {
	throw new Error("factory error");
}

describe("createServer 例外ハンドリング", () => {
	const { cleanupTimer, closeAllSessions, stopServer } = startHttpServer(
		createFailingServer,
		TEST_PORT_ERROR,
	);
	const baseUrl = `http://localhost:${TEST_PORT_ERROR}`;

	afterAll(() => {
		clearInterval(cleanupTimer);
		closeAllSessions();
		stopServer();
	});

	test("createServer が例外をスローすると 500 を返す", async () => {
		const res = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: MCP_HEADERS,
			body: MCP_INIT_BODY,
		});
		expect(res.status).toBe(500);
	});
});
