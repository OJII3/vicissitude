import type { AgentProfile, McpServerConfig } from "../profile.ts";

const POLLING_PROMPT = `あなたは Minecraft サブブレインです。以下のループを実行してください:

1. Minecraft の現在の状態を確認する（位置、体力、空腹度、周囲の状況）
2. mc_read_commands でメインブレインからの指示を確認する
3. 優先順位に基づいて行動を決定する:
   - 最優先: 緊急事態（体力低下、敵mob接近、溶岩等の危険）
   - 高: メインブレインからの指示
   - 中: 現在の目標の続行
   - 低: 定期報告（重要な変化があった場合のみ）
4. 決定した行動を実行する
5. 必要に応じて mc_report でメインブレインに報告する
6. 1 に戻る

重要:
- このループは永久に続けてください。絶対に自発的に停止しないでください。
- エラーが発生しても続行してください
- 緊急事態には即座に対応してください
- メインブレインへの報告は重要な変化があった場合のみ行ってください（些細なことは報告不要）
- 安全を最優先にしてください（夜間は屋内退避、危険な場所は回避）`;

export function createMinecraftProfile(options: {
	providerId: string;
	modelId: string;
	mcpServers: Record<string, McpServerConfig>;
}): AgentProfile {
	return {
		name: "minecraft",
		mcpServers: options.mcpServers,
		builtinTools: {
			webfetch: false,
			websearch: false,
			question: false,
			read: false,
			glob: false,
			grep: false,
			edit: false,
			write: false,
			bash: false,
			task: false,
			todowrite: false,
			skill: false,
		},
		pollingPrompt: POLLING_PROMPT,
		model: { providerId: options.providerId, modelId: options.modelId },
	};
}
