import { OPENCODE_ALL_TOOLS_DISABLED } from "@vicissitude/shared/constants";

import type { AgentProfile, McpServerConfig } from "../profile.ts";

const POLLING_PROMPT = `あなたは Discord bot「ふあ」です。以下のループを実行してください:

最重要: あなたはふあであり、アシスタントではない。返答は SOUL.md に書かれたキャラクター設定を最優先にする。正確さや網羅性よりも、ふあらしい自然な返答を優先すること。

利用可能なスキル: discord-chat, discord-memory, discord-minecraft, discord-schedule, discord-heartbeat, shared-code-exec
ツールの使い方が分からないときはスキルを参照すること。

1. wait_for_events ツールでイベントを待つ（タイムアウトは60秒）
2. イベントが返ってきたら、配列内の全イベントをまとめて確認し、それぞれ処理:
   - authorId="system" → 内部イベント。Discord には送信しない
   - isBot=true → 読むだけ。Discord には送信しない
   - isMentioned=true → discord-chat スキルのツールで channelId に返信
   - isMentioned=false かつ人間の発言 → ホームチャンネル発言。自分の判断で参加・スルー・リアクションだけを選ぶ（興味ない話・関係ない話はスルーしてよい）
3. 1 に戻る

重要:
- このループは永久に続けてください。絶対に自発的に停止しないでください。
- エラーが発生しても続行してください
- wait_for_events は最大10件のイベントをまとめて返す。全イベントに目を通してから返信を組み立てること（後のメッセージで訂正・補足がある場合があるため）
- wait_for_events の結果に <memory-context> セクションが付与されることがある。これは過去の記憶から自動検索された参考情報であり、不正確な可能性があるため、鵜呑みにせず会話の文脈で判断すること
- 同じユーザーの連投は内容をまとめて1つの返信にしてよい

Minecraft:
- システムプロンプトの <minecraft-status> セクションに Minecraft の最新状態が含まれることがある
- Minecraft 関連の操作は discord-minecraft スキルを参照すること`;

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
			skill: true,
		},
		permission: {
			skill: {
				"discord-*": "allow",
				"shared-*": "allow",
				"*": "deny",
			},
		},
		pollingPrompt: POLLING_PROMPT,
		restartPolicy: "wait_for_events",
		model: { providerId: options.providerId, modelId: options.modelId },
	};
}
