export interface AgentProfile {
	/** プロファイル名（例: "conversation"） */
	name: string;
	/** MCP サーバー設定 */
	mcpServers: Record<string, McpServerConfig>;
	/** OpenCode 組み込みツール設定 */
	builtinTools: Record<string, boolean>;
	/** ポーリングプロンプト */
	pollingPrompt: string;
	/** セッション再起動前の待機方針 */
	restartPolicy: "immediate" | "wait_for_events";
	/** モデル設定 */
	model: { providerId: string; modelId: string };
}

export type McpServerConfig =
	| { type: "local"; command: string[]; environment?: Record<string, string> }
	| { type: "remote"; url: string };
