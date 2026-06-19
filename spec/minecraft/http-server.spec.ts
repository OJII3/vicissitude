import { afterAll, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpServer } from "@vicissitude/minecraft/http-server";

import { stubLogger } from "./stub-logger.ts";

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
	const { port, cleanupTimer, closeAllSessions, stopServer } = startHttpServer(
		createTestServer,
		0,
		"test",
		stubLogger,
	);
	const baseUrl = `http://localhost:${port}`;

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

describe("idle タイムアウト無効化", () => {
	function createSlowServer(): McpServer {
		const server = new McpServer({ name: "slow-test", version: "0.1.0" });
		server.registerTool("slow_tool", { description: "slow tool" }, async () => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 2000);
			});
			return { content: [{ type: "text" as const, text: "done" }] };
		});
		return server;
	}

	const handle = startHttpServer(createSlowServer, 0, "slow-test", stubLogger);
	const baseUrl = `http://localhost:${handle.port}`;

	afterAll(() => {
		clearInterval(handle.cleanupTimer);
		handle.closeAllSessions();
		handle.stopServer();
	});

	test("MCP ツール実行が長時間かかっても idle タイムアウトで切断されない", async () => {
		const initRes = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: MCP_HEADERS,
			body: MCP_INIT_BODY,
		});
		const sessionId = initRes.headers.get("mcp-session-id");
		expect(sessionId).toBeTruthy();

		const res = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { ...MCP_HEADERS, "mcp-session-id": sessionId ?? "" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "slow_tool" },
			}),
		});
		expect(res.status).toBe(200);
	});
});

describe("セッション TTL クリーンアップ", () => {
	const handle = startHttpServer(createTestServer, 0, "ttl-test", stubLogger);
	const baseUrl = `http://localhost:${handle.port}`;

	afterAll(() => {
		clearInterval(handle.cleanupTimer);
		handle.closeAllSessions();
		handle.stopServer();
	});

	test("アイドル状態のセッションは TTL 超過で削除される", async () => {
		const initRes = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: MCP_HEADERS,
			body: MCP_INIT_BODY,
		});
		expect(initRes.headers.get("mcp-session-id")).toBeTruthy();
		expect(handle.sessionCount()).toBe(1);

		// lastAccess が確実に過去になるよう 1 tick 待つ
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
		handle.runCleanup(0);
		expect(handle.sessionCount()).toBe(0);
	});

	test("TTL 以内のセッションはクリーンアップで削除されない", async () => {
		const initRes = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: MCP_HEADERS,
			body: MCP_INIT_BODY,
		});
		expect(initRes.headers.get("mcp-session-id")).toBeTruthy();
		expect(handle.sessionCount()).toBe(1);

		// 十分大きな TTL でクリーンアップ → lastAccess が新しいので削除されない
		handle.runCleanup(60 * 60 * 1000);
		expect(handle.sessionCount()).toBe(1);

		// 後片付け
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
		handle.runCleanup(0);
	});
});

function createFailingServer(): McpServer {
	throw new Error("factory error");
}

describe("createServer 例外ハンドリング", () => {
	const { port, cleanupTimer, closeAllSessions, stopServer } = startHttpServer(
		createFailingServer,
		0,
		"test-fail",
		stubLogger,
	);
	const baseUrl = `http://localhost:${port}`;

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
