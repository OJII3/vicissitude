import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type MemoryNamespace, resolveNamespaceFromAgentId } from "@vicissitude/memory/namespace";
import { ConsoleLogger } from "@vicissitude/observability/logger";
import type { Logger } from "@vicissitude/shared/types";

/**
 * AGENT_ID が namespace に解決できなかったときの warn 文言で使うヒント。
 *
 * - `"scope_id"`: tools が `scope_id` の明示を要求する場合（core-server）
 * - `"guild_id"`: tools が `guild_id` の明示を要求する場合（discord-server）
 */
export type MissingScopeHint = "scope_id" | "guild_id";

/**
 * stdio MCP server セットアップコールバックが受け取るコンテキスト。
 */
export interface StdioMcpServerContext {
	/** stderr に出力する logger（stdout は MCP 通信に使われるため）。 */
	readonly logger: Logger;
	/** 検証済みの AGENT_ID（空文字列ではないことが保証される）。 */
	readonly agentId: string;
	/** AGENT_ID から解決された namespace。解決できなければ `undefined`。 */
	readonly boundNamespace: MemoryNamespace | undefined;
	/** `boundNamespace` が agent-scope の場合の scopeId。それ以外は `undefined`。 */
	readonly boundScopeId: string | undefined;
	/** tool 登録対象の McpServer インスタンス。 */
	readonly server: McpServer;
}

/**
 * stdio MCP server の起動オプション。
 */
export interface RunStdioMcpServerOptions {
	/** McpServer の `name`。ログプレフィックスにも `[${name}-server]` として使われる。 */
	readonly name: string;
	/** McpServer の `version`。 */
	readonly version: string;
	/** namespace 未解決時の warn 文言ヒント。 */
	readonly missingScopeHint: MissingScopeHint;
	/**
	 * server 固有のセットアップ。tool 登録などを行い、shutdown 時に呼ばれる
	 * cleanup 関数を返す（不要なら何も返さなくてよい）。
	 *
	 * DISCORD_TOKEN など追加の env 検証もこの中で行い、失敗時は
	 * `ctx.logger.error(...)` の後に `process.exit(1)` する（呼び出し元の既存挙動を保存）。
	 */
	readonly setup: (
		ctx: StdioMcpServerContext,
	) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

/**
 * 3つの stdio MCP server エントリポイント（core / discord / mc-bridge）が共有する
 * 起動骨格を共通化したヘルパ。
 *
 * 担うこと:
 * 1. stderr 向け {@link ConsoleLogger} の生成
 * 2. `AGENT_ID` env の検証（欠落時 `[${name}-server] AGENT_ID environment variable is required`
 *    を error 出力し `process.exit(1)`）
 * 3. `AGENT_ID` からの namespace 解決と、未解決時の warn
 * 4. `boundScopeId` の導出
 * 5. {@link McpServer} の生成
 * 6. `setup` コールバックの呼び出し（tool 登録・追加検証）
 * 7. SIGINT / SIGTERM ハンドラの配線（`server.close()` → setup の cleanup → `process.exit(0)`）
 * 8. {@link StdioServerTransport} 経由の接続
 *
 * server 固有の処理（追加 env 検証・deps 構築・tool 登録・cleanup・server の wrap）は
 * すべて `setup` コールバックに委ねる。
 */
export async function runStdioMcpServer(options: RunStdioMcpServerOptions): Promise<void> {
	const { name, version, missingScopeHint } = options;
	const logger = new ConsoleLogger({ destination: "stderr" });

	const agentId = process.env.AGENT_ID;
	if (!agentId) {
		logger.error(`[${name}-server] AGENT_ID environment variable is required`);
		process.exit(1);
	}

	const boundNamespace: MemoryNamespace | undefined =
		resolveNamespaceFromAgentId(agentId) ?? undefined;
	if (!boundNamespace) {
		logger.warn(
			`[${name}-server] AGENT_ID=${agentId} did not resolve to a known namespace — tools require explicit ${missingScopeHint}`,
		);
	}
	const boundScopeId =
		boundNamespace?.surface === "agent-scope" ? boundNamespace.scopeId : undefined;

	const server = new McpServer({ name, version });

	const cleanup = await options.setup({
		logger,
		agentId,
		boundNamespace,
		boundScopeId,
		server,
	});

	async function shutdown(): Promise<void> {
		await server.close();
		if (cleanup) {
			await cleanup();
		}
		process.exit(0);
	}

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
