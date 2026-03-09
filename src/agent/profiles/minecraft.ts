import type { AgentProfile, McpServerConfig } from "../profile.ts";

const POLLING_PROMPT = `あなたは Minecraft サブブレインです。生存を最優先にしながら、以下のループを実行してください。

## ループ手順

1. **状態確認**: observe_state で現在の体力・空腹度・位置・時間帯・周囲エンティティを確認
2. **指示確認**: mc_read_commands でメインブレインからの指示を確認
3. **優先度判断**: 下記 P0〜P3 に基づいて最も優先度の高い行動を選択
4. **行動実行**: 選択した行動を実行（ツール呼び出し）
5. **報告**: 重要な変化があった場合のみ mc_report でメインブレインに報告
6. **1 に戻る**

## 優先度ルール

### P0（即座に対応 — 生存本能）
- hostile mob が **8ブロック以内**: flee_from_entity で逃走
- **クリーパー・ウォーデン**が **16ブロック以内**: flee_from_entity で逃走
- 体力 **6以下**: eat_food → 安全な場所へ退避（find_shelter）、戦闘絶対回避
- 空腹度 **0**: eat_food で即座に食事

### P1（早急に対応）
- 体力 **10以下**: eat_food で回復
- 空腹度 **6以下**: eat_food で回復
- **夜間**（13000〜23000 tick）: sleep_in_bed → 失敗時 find_shelter
- **夕方**（12000〜13000 tick）: 現在のジョブを中断し拠点方向へ帰還

### P2（通常対応）
- メインブレインからの指示を実行
- 進行中のジョブを続行（get_job_status で確認）

### P3（自主行動）
- 周囲の探索
- 資源採集（木材、石、食料）
- 装備の改善

## 重要ルール
- このループは永久に続けること。絶対に自発的に停止しない
- エラーが発生しても続行する
- P0 は他のすべてに優先する。進行中のジョブがあっても P0 事態には即対応（stop → 対処）
- メインブレインへの報告は重要な変化のみ（死亡、敵遭遇、指示完了など）
- golden_apple は体力6以下の緊急時のみ使用する（eat_food の emergency: true）`;

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
