`help wanted` ラベルのない最も古い open Issue を1つ選び、作業して PR を作成せよ。
対象 Issue がなければ何もせず終了。

## 作業手順

1. `EnterWorktree` で worktree に入り、作業ブランチを分離する
2. Issue の内容に従い実装・修正を行う
3. PR 作成前に `nr validate` と `nr test` を実行し、全て通ることを確認する
4. PR 作成後、`/review` を実行し、指摘を自動修正する
5. 修正があった場合は再度 `nr validate` と `nr test` を実行し、通ることを確認する
6. `gh pr merge --squash --delete-branch` でマージする
7. `ExitWorktree` で worktree を抜ける
