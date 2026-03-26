---
name: discord-memory
description: 長期記憶の検索・参照。ユーザーへの返信前に過去の会話や蓄積ファクトを想起したいとき、特定カテゴリの記憶を確認したいときに使う
---

## 長期記憶ツール（memory サーバー）

fenghuang ベースの認知記憶システム。会話をエピソードに自動分割し、意味記憶（ファクト）に統合する。

> 会話メッセージの記録（ingestion）は自動化されています。
> Discord の全メッセージ（bot 自身の発言を含む）は自動的に記憶に取り込まれます。

- `memory_retrieve(query, limit?)` - 関連する長期記憶をハイブリッド検索で取得
  - テキスト検索＋ベクトル検索＋忘却曲線によるリランキング
  - エピソード記憶（過去の会話まとめ）と意味記憶（蓄積ファクト）の両方を返す
  - **使いどき**: ユーザーへの返信を作成する前に、関連する過去の記憶を想起したいとき
- `memory_get_facts(category?)` - 蓄積されたファクト一覧を取得
  - category: "identity" | "preference" | "interest" | "personality" | "relationship" | "experience" | "goal" | "guideline"
  - **使いどき**: 特定カテゴリのファクトを確認したいとき
