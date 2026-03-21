import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger } from "@vicissitude/shared/types";

interface SessionEntry {
	server: McpServer;
	transport: WebStandardStreamableHTTPServerTransport;
	lastAccess: number;
}

// 30 分
const SESSION_TTL_MS = 30 * 60 * 1000;
// 5 分ごとに掃除
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function createFetchHandler(
	createServer: () => McpServer,
	sessions: Map<string, SessionEntry>,
	label: string,
	logger: Logger,
): (req: Request) => Response | Promise<Response> {
	return async (req) => {
		const pathname = new URL(req.url).pathname;
		if (pathname === "/health")
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		if (pathname !== "/mcp") return new Response("Not Found", { status: 404 });
		const sessionId = req.headers.get("mcp-session-id");
		const entry = sessionId ? sessions.get(sessionId) : undefined;
		if (entry) {
			entry.lastAccess = Date.now();
			return entry.transport.handleRequest(req);
		}
		if (sessionId) return new Response("Session Not Found", { status: 404 });
		if (req.method === "POST") {
			let server: McpServer;
			try {
				server = createServer();
			} catch (err) {
				logger.error(`[${label}] failed to create MCP server session:`, err);
				return new Response("Internal Server Error", { status: 500 });
			}
			const t = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
				onsessioninitialized: (id) => {
					sessions.set(id, { server, transport: t, lastAccess: Date.now() });
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

export interface HttpServerHandle {
	port: number;
	cleanupTimer: ReturnType<typeof setInterval>;
	closeAllSessions: () => void;
	stopServer: () => void;
}

export function startHttpServer(
	createServer: () => McpServer,
	port: number,
	label: string,
	logger: Logger,
): HttpServerHandle {
	const sessions = new Map<string, SessionEntry>();
	const httpServer = Bun.serve({
		port,
		idleTimeout: 255,
		fetch: createFetchHandler(createServer, sessions, label, logger),
	});

	const closeAllSessions = (): void => {
		for (const [id, entry] of sessions) {
			entry.server.close().catch(() => {});
			entry.transport.close().catch(() => {});
			sessions.delete(id);
		}
	};

	const stopServer = (): void => {
		httpServer.stop(true);
	};

	const cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [id, entry] of sessions) {
			if (now - entry.lastAccess > SESSION_TTL_MS) {
				entry.server.close().catch(() => {});
				entry.transport.close().catch(() => {});
				sessions.delete(id);
			}
		}
	}, SESSION_CLEANUP_INTERVAL_MS);

	logger.info(`[${label}] MCP server listening on port ${httpServer.port}`);

	return { port: httpServer.port ?? port, cleanupTimer, closeAllSessions, stopServer };
}
