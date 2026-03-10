# CHANGELOG.md

完了済みマイルストーン、タスク、設計判断の記録。

## 完了済みマイルストーン

| ID   | 名前                                    | 完了 | 備考                                       |
| ---- | --------------------------------------- | ---- | ------------------------------------------ |
| M1   | Clean Architecture 移行                 | ✅   |                                            |
| M2   | 品質強化・既知バグ修正                  | ✅   |                                            |
| M3   | 堅牢性強化                              | ✅   |                                            |
| M4   | 機能拡張（Heartbeat、ホームチャンネル） | ✅   | プラットフォーム抽象化は将来スコープに延期 |
| M5   | 記憶システム統合（Phase 1-3）           | ✅   |                                            |
| M6   | Minecraft 拡張                          | ✅   |                                            |
| M7   | 基盤層 — core/ + store/                 | ✅   | PR #93                                     |
| M8   | MCP サーバー統合                        | ✅   | PR #93                                     |
| M9   | エージェント抽象化                      | ✅   | PR #93                                     |
| M10  | ブートストラップ + ゲートウェイ簡素化   | ✅   | PR #93                                     |
| M11  | クリーンアップ + ドキュメント更新       | ✅   | PR #93                                     |
| M12a | サブブレイン基盤                        | ✅   | PR #96                                     |
| M12b | リアクティブ行動 — サバイバル本能       | ✅   | PR #96                                     |
| M12c | 目標管理 — 自動カリキュラム             | ✅   | PR #96                                     |
| M12d | メインブレイン統合                      | ✅   | PR #96、デプロイ 2026-03-10                |

## 主要タスク完了記録

- **アーキテクチャリファクタリング（5 Phase）**（ブランチ: feat/opencode-session-port-adapter）:
  - Phase 1: Port 統一 & SDK 依存除去
  - Phase 2: core-server HTTP 化（stdio → StreamableHTTP）
  - Phase 3: スケジューラ分離（gateway/ → scheduling/）
  - Phase 4-A: bootstrap 分解（420 行 → factory 関数群）
  - Phase 4-B: テスト追加（16 テスト追加、計 320 テスト pass）

- **Minecraft エージェント（M12a-M12d）** — PR #96、デプロイ済み 2026-03-10
  - レビュー修正 5 回: setInterval → 再帰 setTimeout、peekBridgeEvents SQL LIMIT、insertBridgeEvent 自動パージ、eat_food/find_shelter エラーハンドリング、サニタイズ関数切り出し、mc-check 自動有効化、ドキュメント整合性修正、McBrainManager テスト追加

- **attack_entity MCP ツール追加** — PR #108
  - モブ攻撃アクション（ジョブベース非同期実行、最適武器自動装備、エンティティ死亡検知）
  - プロファイル優先度ルール更新（P0: 逃走失敗時の反撃、P3: 食料狩り）

- **mc-bridge 分割 + discord/minecraft 命名統一** — PR #106
  - mc-bridge.ts を discord/minecraft/shared の 3 ファイルに分割
  - main/sub 命名を discord/minecraft に統一
  - 結合テスト 12 件追加（計 332 テスト pass）
  - lefthook で git pre-commit hook 管理（DEPS.md 自動再生成）

## 設計判断の記録（ADR）

> 詳細は `ARCHITECTURE.md` §10 を参照。ここには補足的な根拠のみ記載。

- **ポート層廃止**: 14 ポート中モック差し替えされるのは 2-3 個。実装 1 つのインターフェースは YAGNI 違反。
- **ユースケース層廃止**: 1 行の委譲をクラスにしても可読性・テスタビリティ向上なし。
- **Effect-TS 不採用**: 学習コスト・参入障壁。OpenCode SDK が Promise ベース。
- **Markdown メモリ非 SQLite 化**: AI が MCP で直接読み書きする形式として Markdown が最適。
- **fenghuang 非内製化**: Episode/SemanticFact モデルと FSRS スケジューリングが十分機能。

## 解消済みリスク

| ID  | リスク                                    | 対策                                               |
| --- | ----------------------------------------- | -------------------------------------------------- |
| R1  | SQLite マイグレーション中のデータロス     | JSON → SQLite マイグレーションスクリプトで対応済み |
| R2  | MCP 統合で OpenCode との接続不良          | 段階的統合で検証済み                               |
| R3  | Drizzle ORM の Bun 互換性問題             | `bun:sqlite` ドライバで問題なし                    |
| R4  | event-buffer の SQLite 化でポーリング遅延 | WAL モードで即時性維持                             |
| R5  | 大規模リファクタリング中の本番不安定      | マイルストーン単位デプロイで安定                   |
| R6  | fenghuang ライブラリの SQLite 統合        | 独立 SQLite 維持で問題なし                         |
| —   | code-exec RCE リスク                      | Podman コンテナ化で対策済み                        |
