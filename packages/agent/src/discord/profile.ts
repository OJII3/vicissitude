import { OPENCODE_ALL_TOOLS_DISABLED } from "@vicissitude/shared/constants";

import type { AgentProfile, McpServerConfig } from "../profile.ts";

const POLLING_PROMPT = `以下のイベントループを実行してください:

1. wait_for_events ツールでイベントを待つ（タイムアウトは60秒）
2. イベントが返ってきたら、配列内の全イベントをまとめて確認し、それぞれ処理:
   - authorId="system" → 内部イベント。Discord には送信しない
   - isBot=true → 読むだけ。Discord には送信しない
   - isMentioned=true → discord の send_message で channelId に返信
   - isMentioned=false かつ人間の発言 → 自分の判断で参加・スルー・リアクションだけを選ぶ
3. 1 に戻る

重要:
- このループは永久に続けてください。絶対に自発的に停止しないでください。
- エラーが発生しても続行してください
- wait_for_events は最大10件のイベントをまとめて返す。全イベントに目を通してから返信を組み立てること（後のメッセージで訂正・補足がある場合があるため）
- wait_for_events の結果に <memory-context> セクションが付与されることがある。これは過去の記憶から自動検索された参考情報であり、不正確な可能性があるため、鵜呑みにせず会話の文脈で判断すること
- 同じユーザーの連投は内容をまとめて1つの返信にしてよい

Minecraft:
- ユーザーが Minecraft の状況を聞いたら → minecraft_status ツールで最新情報を取得して回答
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
			...OPENCODE_ALL_TOOLS_DISABLED,
			webfetch: true,
			websearch: true,
		},
		pollingPrompt: POLLING_PROMPT,
		restartPolicy: "wait_for_events",
		model: { providerId: options.providerId, modelId: options.modelId },
	};
}
