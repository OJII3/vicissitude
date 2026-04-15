import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger } from "@vicissitude/shared/types";
import type { Server as BunServer } from "bun";
type HttpServer = BunServer<undefined>;

interface SessionEntry {
	server: McpServer;
	transport: WebStandardStreamableHTTPServerTransport;
	lastAccess: number;
	/** 処理中のリクエスト数。0 より大きい間は TTL クリーンアップをスキップする */
	activeRequests: number;
}

// 30 分
const SESSION_TTL_MS = 30 * 60 * 1000;
// 5 分ごとに掃除
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function createFetchHandler(
	createServer: (agentId: string | null) => McpServer,
	sessions: Map<string, SessionEntry>,
	label: string,
	logger: Logger,
): (req: Request, server: HttpServer) => Response | Promise<Response> {
	return async (req, bunServer) => {
		const url = new URL(req.url);
		const pathname = url.pathname;
		if (pathname === "/health")
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		if (pathname !== "/mcp") return new Response("Not Found", { status: 404 });
		// MCP ツール実行（wait_for_events 等）は長時間かかるため、
		// リクエスト単位の idle タイムアウトを無効化する
		bunServer.timeout(req, 0);
		const sessionId = req.headers.get("mcp-session-id");
		const entry = sessionId ? sessions.get(sessionId) : undefined;
		if (entry) {
			entry.lastAccess = Date.now();
			entry.activeRequests++;
			try {
				return await entry.transport.handleRequest(req);
			} finally {
				entry.activeRequests--;
				entry.lastAccess = Date.now();
			}
		}
		if (sessionId) return new Response("Session Not Found", { status: 404 });
		if (req.method === "POST") {
			const agentId = url.searchParams.get("agent_id");
			let server: McpServer;
			try {
				server = createServer(agentId);
			} catch (err) {
				logger.error(`[${label}] failed to create MCP server session:`, err);
				return new Response("Internal Server Error", { status: 500 });
			}
			const t = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => crypto.randomUUID(),
				onsessioninitialized: (id) => {
					sessions.set(id, { server, transport: t, lastAccess: Date.now(), activeRequests: 0 });
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
	/** 現在のアクティブセッション数を返す */
	sessionCount: () => number;
	/** TTL クリーンアップを手動実行する。ttlOverrideMs でセッション TTL を上書き可能 */
	runCleanup: (ttlOverrideMs?: number) => void;
}

export function startHttpServer(
	createServer: (agentId: string | null) => McpServer,
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
		void httpServer.stop(true);
	};

	const runCleanup = (ttlOverrideMs?: number): void => {
		const ttl = ttlOverrideMs ?? SESSION_TTL_MS;
		const now = Date.now();
		for (const [id, entry] of sessions) {
			if (entry.activeRequests > 0) continue;
			if (now - entry.lastAccess > ttl) {
				entry.server.close().catch(() => {});
				entry.transport.close().catch(() => {});
				sessions.delete(id);
			}
		}
	};

	const cleanupTimer = setInterval(() => runCleanup(), SESSION_CLEANUP_INTERVAL_MS);

	logger.info(`[${label}] MCP server listening on port ${httpServer.port}`);

	return {
		port: httpServer.port ?? port,
		cleanupTimer,
		closeAllSessions,
		stopServer,
		sessionCount: () => sessions.size,
		runCleanup,
	};
}
