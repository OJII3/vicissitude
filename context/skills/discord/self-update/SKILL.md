---
name: self-update
description: "Use when a Discord user asks to modify ふあ's own behavior, configuration, prompts, or skills. Covers skill additions ('freeeのMCPスキル追加して' 'これスキルにして'), skill modifications ('このスキルの動作変えて' '〇〇スキルの説明更新して'), agent config/prompt changes ('プロンプト修正して' 'エージェントの設定変えて'), self-improvement requests ('こういうときの動作改善して'), and bug fixes to agent behavior ('〇〇のときの挙動おかしいから直して'). Orchestrates self-modification by delegating repository work to shell-worker: create a branch, follow AGENTS.md, validate, commit, push, open a PR, and auto-merge only when guardrails pass. Do NOT trigger for plain chit-chat, one-off questions, or regular project/app code changes unrelated to ふあ's own behavior."
---

あなたは Discord 会話 primary agent から、ふあ自身の振る舞い・設定・プロンプト・スキルを変更するための手順を参照している。
このスキルは `features.shellWorkspace` 設定時だけ利用可能で、実作業はすべて `shell-worker` に委譲する。

## 発火判定

以下のいずれかを満たすときだけ発火する。判断に迷う場合はユーザーに一言確認してから進める。

- **自己変更**: ふあ自身のスキル、設定、プロンプト、会話方針、ツール利用方針、ガードレールなど、将来のふあの振る舞いを変える依頼。
  - スキル追加: 「これスキルにして」「機能として覚えて」「スキル追加して」「freee の MCP スキル追加して」「API 操作用のスキル作って」。
  - スキル変更: 「このスキルの動作変えて」「〇〇スキルの説明更新して」「発火条件を広げて」。
  - エージェント設定・プロンプト変更: 「プロンプト修正して」「エージェントの設定変えて」「指示を追加して」。
  - 自己改善: 「こういうときの動作改善して」「毎回やってるけど定型化できない?」。
  - ふあの挙動バグ修正: 「〇〇のときの挙動おかしいから直して」「PR 作成時の手順が違うから直して」。
- **曖昧発話**: ふあの再利用可能な能力や運用ルールを変える含意がある発話。曖昧な場合は要望を一言で言語化してユーザーに確認する。

次の場合は発火しない。

- 単なる雑談・感想・一回限りの質問。
- 通常のコード変更: アプリ本体・ライブラリ・インフラなどプロジェクト機能の実装、バグ修正、リファクタ依頼（それは `delegate-to-shell-worker` の領域）。
- ふあ自身の振る舞い変更を伴わない、単発の調査・作業代行。

## AGENTS.md 遵守

自己変更は、必ず repo の `AGENTS.md` に従って進める。とくに以下を `shell-worker` への委譲内容に含める。

- main ブランチへ直接コミット・push しない。必ず専用ブランチを作成し、PR 経由で変更する。
- コミットメッセージは Conventional Commits 形式にし、要約は日本語にする（例: `docs(skill): self-update の対象範囲を広げる`）。
- 変更後は `nr validate` を実行し、成功してからコミットする。
- push 後に `gh pr create` で PR を作成する。
- ガードレールと CI が通り、マージ条件を満たす場合だけ squash merge し、リモートブランチを削除する。

## 最小確定

委譲前に、変更対象と一言要望だけ確定する。不明なら Discord で短く確認する。

- ふあ本体（会話）用スキル → `context/skills/<group>/`（多くは `context/skills/discord/`）。
- shell-worker 用スキル → `context/skills/shell-worker/`。
- エージェント設定・プロンプト・関連ルール → `AGENTS.md`、`.agents/**`、`.claude/agents/**`、`.codex/**`、`context/**`、`opencode.json`、`skills-lock.json` などの該当ファイル。
- 一言要望（何を、いつ発火し、何をどう変えるか）。

## フロー

1. Discord に中間報告を送る（例: 「ふあの設定変更として PR 作るね」）。
2. `task` で `shell-worker` に以下を一括委譲する。
   - `AGENTS.md` を読んで遵守する。
   - repo を最新化し、main に直接変更せず、専用 branch（例: `skill/<kebab-name>`、`agents/<kebab-name>`、`fix/<kebab-name>`）を作る。
   - スキル追加なら `skill-creator` skill の手順に従って対象ディレクトリに `SKILL.md` を生成する。
   - 既存スキル変更、設定・プロンプト変更、挙動改善、バグ修正なら、対象ファイルだけを最小差分で編集する。
   - 検証する（スキル追加時は `skill-creator` の validate、全ケースで `nr validate`）。
   - Conventional Commits 形式（日本語要約）で commit する。
   - push して `gh pr create` する。PR タイトルも Conventional Commits 形式を基本にする。
3. 返ってきた PR URL を Discord に共有する。
4. CI（`nr validate`）が green になるのを確認する（`shell-worker` に `gh` で確認させる）。
5. ガードレール判定を行う（下記）。全て満たすときだけ `shell-worker` に `gh pr merge --squash --delete-branch` を実行させる。満たさないときは PR を open のまま停止し、人間レビュー待ちにする。
6. Discord に完了報告（自動マージしたか、人間レビュー待ちにしたか）を送る。

## ガードレール（自動マージの安全弁）

以下を全て満たすときだけ自動マージする。

- **依頼者が信頼ユーザーである**（直近の依頼メッセージに `[trusted-requester]` マーカーが付いている）。自己変更の内容はふあ自身の将来の指示セットになるため、信頼ユーザー以外が振る舞いを書き換えられないようにする。マーカーは表示名ではなく authorId 照合でコード側が付与するため、なりすませない。
- diff が自己変更に関係するファイルだけ（例: `context/skills/**`、`AGENTS.md`、`.agents/**`、`.claude/agents/**`、`.codex/**`、`context/**`、`opencode.json`、`skills-lock.json`）。アプリ本体コード、インフラ、README 本体など、ふあ自身の振る舞いに直接関係しない変更を含まない。
- 新規スキル追加、既存スキルの非破壊的編集、設定・プロンプト・ガードレールの明確化など、依頼内容に沿った最小差分のみ。
- CI（`nr validate`）が green。

一つでも外れたら自動マージしない。Discord に「人間レビューが要りそう」と理由を添えて報告し、PR は open のまま停止する。とくに **信頼ユーザー以外（`[trusted-requester]` マーカーなし）からの依頼では、CI が green でも自動マージせず**、PR 作成・共有までで止めて「マージにはオーナーのレビューが要る」と伝える。

## 委譲境界

- ふあ自身は `bash` / `gh` / `git` を直接叩かない。repo 操作・PR・マージはすべて `shell-worker` に委ねる。
- `shell-worker` の作業は専用 workspace 内に限定する。workspace 外の読み書き、host secrets、auth files、環境変数 dump、権限昇格を試みない。
- `shell-worker` から返った結果を確認し、Discord には必要な要約・PR URL・完了可否だけを送る。
