import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

interface SessionEntry {
	transport: WebStandardStreamableHTTPServerTransport;
	lastAccess: number;
}

// 30 分
const SESSION_TTL_MS = 30 * 60 * 1000;
// 5 分ごとに掃除
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function createFetchHandler(
	server: McpServer,
	sessions: Map<string, SessionEntry>,
): (req: Request) => Response | Promise<Response> {
	return async (req) => {
		if (new URL(req.url).pathname !== "/mcp") return new Response("Not Found", { status: 404 });
		const sessionId = req.headers.get("mcp-session-id");
		const entry = sessionId ? sessions.get(sessionId) : undefined;
		if (entry) {
			entry.lastAccess = Date.now();
			return entry.transport.handleRequest(req);
		}
		if (req.method === "POST" && !sessionId) {
			const t = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
				onsessioninitialized: (id) => {
					sessions.set(id, { transport: t, lastAccess: Date.now() });
				},
				onsessionclosed: (id) => {
					sessions.delete(id);
				},
			});
			/* oxlint-disable-next-line prefer-add-event-listener -- SDK callback property */
			t.onclose = () => {
				const id = t.sessionId;
				if (id) sessions.delete(id);
			};
			await server.connect(t);
			return t.handleRequest(req);
		}
		return new Response("Bad Request", { status: 400 });
	};
}

export function startHttpServer(
	server: McpServer,
	port: number,
): { cleanupTimer: ReturnType<typeof setInterval> } {
	const sessions = new Map<string, SessionEntry>();

	const cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [id, entry] of sessions) {
			if (now - entry.lastAccess > SESSION_TTL_MS) {
				entry.transport.close().catch(() => {});
				sessions.delete(id);
			}
		}
	}, SESSION_CLEANUP_INTERVAL_MS);

	// MCP StreamableHTTP は長時間接続を維持するため、アイドルタイムアウトを最大値に設定
	Bun.serve({
		port,
		idleTimeout: 255,
		fetch: createFetchHandler(server, sessions),
	});

	console.error(`[minecraft] MCP server listening on port ${port}`);

	return { cleanupTimer };
}
