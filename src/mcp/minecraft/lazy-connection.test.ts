import { afterAll, describe, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { startHttpServer } from "../http-server.ts";
import { parseMcpResponse } from "../test-helpers.ts";
import { createBotContext } from "./bot-context.ts";
import { JobManager } from "./job-manager.ts";
import { registerMinecraftTools } from "./mcp-tools.ts";

describe("BotContext — bot null 時の安全性", () => {
	test("getBot() === null の状態で pushEvent が正常動作", () => {
		const ctx = createBotContext();
		expect(ctx.getBot()).toBeNull();

		// pushEvent はクラッシュしない
		ctx.pushEvent("test", "テストイベント", "medium");
		expect(ctx.getEvents()).toHaveLength(1);
		expect(ctx.getEvents().at(0)?.kind).toBe("test");
	});

	test("getBot() === null の状態で getEvents が正常動作", () => {
		const ctx = createBotContext();
		expect(ctx.getBot()).toBeNull();
		expect(ctx.getEvents()).toEqual([]);
	});

	test("getBot() === null の状態で getActionState が正常動作", () => {
		const ctx = createBotContext();
		expect(ctx.getBot()).toBeNull();
		expect(ctx.getActionState()).toEqual({ type: "idle" });
	});
});

describe("HTTP 経由で bot 未接続ツールが graceful に応答", () => {
	const TEST_PORT = 49_741;
	const baseUrl = `http://localhost:${TEST_PORT}`;

	const ctx = createBotContext();
	const jobManager = new JobManager(
		() => {},
		() => {},
	);

	function createTestServer(): McpServer {
		const server = new McpServer({ name: "test-minecraft", version: "0.1.0" });
		registerMinecraftTools(server, ctx, jobManager, 3007);
		return server;
	}

	const { cleanupTimer, closeAllSessions } = startHttpServer(
		createTestServer,
		TEST_PORT,
		"test-minecraft",
	);

	afterAll(() => {
		clearInterval(cleanupTimer);
		closeAllSessions();
	});

	const MCP_HEADERS = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};

	test("observe_state が『ボット未接続』を返す", async () => {
		// セッション作成
		const initRes = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: MCP_HEADERS,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "0.1.0" },
				},
			}),
		});
		expect(initRes.status).toBe(200);
		const sessionId = initRes.headers.get("mcp-session-id") ?? "";
		expect(sessionId).toBeTruthy();

		// observe_state ツール呼び出し
		const toolRes = await fetch(`${baseUrl}/mcp`, {
			method: "POST",
			headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "observe_state", arguments: {} },
			}),
		});
		expect(toolRes.status).toBe(200);

		const result = (await parseMcpResponse(toolRes)) as {
			result?: { content: { type: string; text: string }[] };
		};
		expect(result.result).toBeDefined();
		expect(result.result?.content.at(0)?.text).toContain("ボット未接続");
	});
});
