# STATUS.md

## 1. 最終更新

- 2026-03-11
- 更新者: claude-code
- ブランチ: main（PR #106 マージ後）

## 2. 現在の状態

- M7-M12d 全マイルストーン完了。責務別フラットモジュール構成で稼働中。
- Minecraft エージェント（サブブレイン）デプロイ済み（2026-03-10）。
- `nr validate` 通過。計 332 テスト pass。

## 3. 既知のバグ・要修正事項

- `GuildRouter.send()` がエラーを同期スロー（`.catch()` のみの呼び出し元が増えたら `Promise.reject()` に変更要）。
- Ollama イメージタグ `latest` 固定。バージョン固定を将来検討。
- `HeartbeatScheduler` / `ConsolidationScheduler` の二重タイムアウトで最悪 tick 時間が 2 倍（6 分 / 20 分）。
- 旧テスト（Guild 部分成功/失敗、`InstrumentedAiAgent`、`GuildRoutingAgent`）が新構成に未移植。

## 4. 直近タスク

- 未移植テストの追加（旧 Guild テスト、InstrumentedAiAgent テスト等）。
- 運用観察: Minecraft エージェントの実際の動作確認・チューニング。

## 5. ブロッカー

- なし。
