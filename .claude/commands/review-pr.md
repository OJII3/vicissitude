---
allowed-tools: Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*),Bash(git diff:*),Bash(git log:*)
description: PRの包括的なコードレビューを実行する
---

# PR Review

以下のサブエージェントを使って、現在のPRの包括的なコードレビューを実行してください。

## 手順

1. まず `git diff main...HEAD` で変更差分を確認してください
2. 以下の5つのサブエージェントを**並列に**起動し、各専門領域のレビューを実施してください:
   - **code-quality-reviewer**: コード品質のレビュー
   - **security-reviewer**: セキュリティのレビュー
   - **performance-reviewer**: パフォーマンスのレビュー
   - **test-coverage-reviewer**: テストカバレッジのレビュー
   - **documentation-reviewer**: ドキュメントの正確性のレビュー

3. 各サブエージェントには「注目すべきフィードバックのみ」を報告するよう指示してください
4. 全サブエージェントの結果を収集した後、あなた自身が**二段階フィルタリング**を行い、本当に重要なフィードバックのみを残してください

## フィルタリング基準

以下は除外してください:

- oxlint / oxfmt で自動検出できるスタイルの問題
- 理論上のリスクで実際には問題にならないもの
- マイクロ最適化の提案
- 個人的な好みの問題

## 出力フォーマット

最終的なレビュー結果を以下の形式でまとめてください:

```markdown
## Code Review Summary

### Critical Issues

- [ ] (あれば記載)

### Important Findings

- [ ] (あれば記載)

### Minor Suggestions

- (あれば記載)

### Good Points

- (良い点があれば記載)
```

- 具体的な問題はファイルパスと行番号を含めてください
- 問題がない場合は「問題は見つかりませんでした」と報告してください
- フィードバックは日本語で記述してください
