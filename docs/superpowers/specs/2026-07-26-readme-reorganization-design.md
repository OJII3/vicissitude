# README 再構成設計

## 目的

README を一時的な Phase 1 の作業記録ではなく、Vicissitude の概要、開発手順、運用手順を案内する恒久的な入口にする。

## 方針

- タイトルを `Vicissitude` にする。
- 冒頭では現在の実装範囲を説明し、プロジェクト自体を `Phase 1` と呼ばない。
- 詳細な初期構築、デプロイ、障害復旧の手順は README に残す。
- 読者の目的に沿って、概要から開発、構成、初期構築、運用、障害復旧、リファレンスの順に並べる。
- 同じ前提や禁止事項を複数箇所で繰り返さず、最も関係する節にまとめる。
- コマンドの意味や安全上の条件は変えない。

## 構成

README は次の順序にする。

1. `Vicissitude`: プロジェクトの目的と現在の実装範囲
2. `Development`: 必要なツール、開発 shell、install、build、test
3. `Architecture`: Gateway、cognition worker、admin CLI の責務とプロセス境界
4. `Initial Setup`: database migration と CharacterDefinition の初期登録
5. `Operations`: operator environment、go-live、通常の deploy
6. `Recovery`: unknown effect、shutdown、drain、lease recovery
7. `Configuration Reference`: Discord、model、database、health、credential boundary
8. `Tests And Layout`: CI と主要ディレクトリ

既存のコードブロックは対応する節へ移し、手順の実行順序を維持する。

## 非対象

- 運用手順の別文書への分割
- CLI や環境変数の仕様変更
- 実装済み範囲の拡張
- 将来フェーズの詳細なロードマップ追加

## 確認

- README の見出しだけで、概要、開発、運用、復旧の情報を探せること。
- 既存のコマンドと安全条件が再構成後も残っていること。
- `Phase 1` がプロジェクト名や README の中心的な構成概念として残っていないこと。
- Markdown の見出し構造とコードブロックが崩れていないこと。
