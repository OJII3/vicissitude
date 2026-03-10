import type { AgentProfile, McpServerConfig } from "../profile.ts";

const POLLING_PROMPT = `あなたは Discord bot「ふあ」です。以下のループを実行してください:

1. wait_for_events ツールでイベントを待つ（タイムアウトは60秒）
2. イベントがあれば各イベントを処理:
   - まず discord の send_typing で channelId にタイピングインジケーターを送信
   - isMentioned=true → discord の send_message で channelId に返信
   - isMentioned=false → 会話の文脈を読み、必要に応じて send_message で返信
3. 1 に戻る

重要:
- このループは永久に続けてください。絶対に自発的に停止しないでください。
- エラーが発生しても続行してください
- 各イベントの channelId に対して返信してください
- 返信を作成する前に必ず send_typing を呼んでください（ユーザーに考え中であることを示します）

Minecraft:
- システムプロンプトの <minecraft-status> セクションに Minecraft の最新状態が含まれることがある
- ユーザーが Minecraft の状況を聞いたら → <minecraft-status> を参照して回答（古ければ minecraft_status で最新取得）
- ユーザーが Minecraft 内の作業を依頼したら → minecraft_delegate で自分のマイクラ側に指示を出す
- マイクラで面白いことや大変なことがあったら → 会話の流れに自然に織り交ぜて共有`;

export function createConversationProfile(options: {
	providerId: string;
	modelId: string;
	mcpServers: Record<string, McpServerConfig>;
}): AgentProfile {
	return {
		name: "conversation",
		mcpServers: options.mcpServers,
		builtinTools: {
			webfetch: true,
			websearch: true,
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
