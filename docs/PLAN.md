# PLAN.md

## 1. 方針

- 小さく作って早く動かす。
- 複雑な最適化より、会話体験と運用しやすさを優先する。
- Clean Architecture の原則に従い、テスタビリティを重視する。

## 2. マイルストーン

### M1: Clean Architecture 移行 ✅

成果物:

- domain / application / infrastructure の 3 層構成
- ポートベースの DI 配線
- レガシーコードの削除

完了条件:

- 依存方向ルールが守られている
- `nr validate` が通る
- 既存機能（メンション応答・スレッド応答）が動作する

### M2: 品質強化・既知バグ修正 ✅

成果物:

- ユニットテスト（domain / application）
- 既知バグの修正（詳細は STATUS.md 参照）
- エラーハンドリングの改善

完了条件:

- `splitMessage()` と `HandleIncomingMessageUseCase` のテストが通る
- エラーメッセージが Discord に漏洩しない
- セッション再作成時にコンテキストが正しく system prompt として注入される

### M3: 堅牢性強化 ✅

成果物:

- セッション永続化の競合対策
- Graceful shutdown の実装
- Logger の統一利用

完了条件:

- 同時メッセージでファイル破損が起きない
- SIGINT/SIGTERM で正常終了する
- 全コンポーネントが Logger ポート経由でログ出力する

### M4: 機能拡張

成果物:

- ~~heartbeat（定期実行）~~ ✅ 実装済み
- ~~チャンネル限定フィルタリング~~ ✅ ホームチャンネル機能として実装済み
- プラットフォーム抽象化（`"discord"` ハードコードの解消）

### M5: 記憶システム統合

ファイルベースメモリと LTM の責任範囲を段階的に整理し、重複を解消する。

#### Phase 1: LTM ファクトをシステムプロンプトに注入 ✅

成果物:

- `LtmFactReader` ポート（domain 層）
- `FenghuangFactReader` アダプタ（infrastructure 層、SQLite 読み取り専用）
- `FileContextLoader` への `<ltm-facts>` セクション注入
- `composition-root.ts` の DI 配線更新
- `context/HEARTBEAT.md` に `ltm_consolidate` 定期実行の追記

完了条件:

- ブートストラップコンテキストに `<ltm-facts>` セクションが含まれる
- Clean Architecture の依存方向ルールが守られている（`FileContextLoader` → `LtmFactReader` ポート経由）
- `nr validate` が通る
- ltm-server と同時アクセスしてもデータ破損しない（WAL モード）

#### Phase 2: MEMORY.md のスリム化

成果物:

- MEMORY.md テンプレートの更新（運用設定・行動ルール・週次目標に限定）
- HEARTBEAT.md の memory-update 手順更新
- TOOLS.md の `update_memory` 説明更新

完了条件:

- ユーザー情報が MEMORY.md と LTM に重複して記録されない運用が確立
- MEMORY.md の責任範囲が明確に文書化されている

#### Phase 3: 日次ログ再設計 + LESSONS.md 整理

成果物:

- 日次ログの記録内容を限定（heartbeat 実行記録・自省メモのみ）
- LESSONS.md 更新時に LTM guideline ファクトを参照する運用手順
- （オプション）ファクト件数上限（50 件）+ カテゴリ優先度ソート

完了条件:

- 日次ログと LTM Episodes の記録内容が重複しない
- LESSONS.md と LTM guideline の役割分担が明確

#### フェーズ間依存

- Phase 2 は Phase 1 に依存（LTM ファクトがプロンプトに注入される前に MEMORY.md をスリム化すると情報ロス）
- Phase 3 は Phase 2 に依存（一度に変えすぎない）
- 各フェーズ間に数日の観察期間を設ける

## 3. リスクレジスタ

| ID  | リスク                               | 影響                 | 対策                                            |
| --- | ------------------------------------ | -------------------- | ----------------------------------------------- |
| R1  | AI が返信しすぎる / しなさすぎる     | 会話体験の悪化       | コンテキストドキュメントで制御                  |
| R2  | セッションファイルの同時書き込み競合 | データ破損           | 書き込みキューまたは SQLite 移行                |
| R3  | OpenCode セッションのリモート消失    | コンテキスト注入漏れ | 毎回 system prompt で注入するため解消           |
| R4  | code-exec MCP にサンドボックスなし   | RCE                  | ✅ Podman コンテナ化実装済み                    |
| R5  | エラーメッセージの Discord 漏洩      | 内部情報露出         | 汎用メッセージ返却 + ログのみ記録               |
| R6  | テストゼロ状態でのリグレッション     | 品質低下             | M2 で最低限のテスト追加                         |
| R7  | MEMORY.md スリム化時の情報ロス       | 会話品質低下         | Phase 1 完了後に Phase 2 実施、観察期間を設ける |
| R8  | LTM ファクトのノイズ混入             | プロンプト品質低下   | 件数上限 + カテゴリ優先度ソートで対策           |

## 4. 完了定義（DoD）

- `SPEC.md` の受け入れ条件を満たす。
- コード変更はレビュー可能な最小差分である。
- ドキュメントが現在の挙動と矛盾しない。
- `STATUS.md` が作業ごとに更新されている。
- `nr validate` が通る。
