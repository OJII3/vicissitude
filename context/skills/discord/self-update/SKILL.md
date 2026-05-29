---
name: self-update
description: "Use when a Discord user asks to turn a capability into a skill ('これスキルにして' '機能として覚えて' 'スキル追加して' 等の明示依頼) or implies a recurring capability would help ('こういう機能欲しくない?' '毎回やってもらってるけど定型化できない?' 等の曖昧発話). Orchestrates skill-addition by delegating to shell-worker: create a skill SKILL.md, open a PR, and auto-merge only when guardrails pass. Do NOT trigger for plain chit-chat, one-off questions, or general implementation/code-change requests that are not about adding a reusable skill."
---

あなたは Discord 会話 primary agent から、新しいスキルを追加するための手順を参照している。
このスキルは `features.shellWorkspace` 設定時だけ利用可能で、実作業はすべて `shell-worker` に委譲する。

## 発火判定

以下のいずれかを満たすときだけ発火する。判断に迷う場合はユーザーに一言確認してから進める。

- 明示依頼: 「これスキルにして」「機能として覚えて」「スキル追加して」など、再利用可能な能力の追加を直接求める発話。
- 曖昧発話: 「こういう機能欲しくない?」「毎回やってるけど定型化できない?」など、繰り返し使える能力があると便利そうな含意。曖昧な場合は要望を一言で言語化してユーザーに確認する。

次の場合は発火しない。

- 単なる雑談・感想・一回限りの質問。
- スキル化を伴わない実装依頼・コード変更依頼（それは `delegate-to-shell-worker` の領域）。

## 最小確定

委譲前に、対象スキルの置き場と一言要望だけ確定する。不明なら Discord で短く確認する。

- ふあ本体（会話）用スキル → `context/skills/<group>/`（多くは `context/skills/discord/`）
- shell-worker 用スキル → `context/skills/shell-worker/`
- スキルの一言要望（何を、いつ発火し、何をするか）

## フロー

1. Discord に中間報告を送る（例: 「スキル作るね」）。
2. `task` で `shell-worker` に以下を一括委譲する。
   - repo を最新化する。
   - branch `skill/<kebab-name>` を作る。
   - `skill-creator` skill の手順に従って対象ディレクトリに `SKILL.md` を生成する。
   - 検証する（`skill-creator` の validate と `nr validate`）。
   - push して `gh pr create` する。PR タイトルは `feat(skill): add <name> skill`。
3. 返ってきた PR URL を Discord に共有する。
4. CI（`nr validate`）が green になるのを確認する（`shell-worker` に `gh` で確認させる）。
5. ガードレール判定を行う（下記）。全て満たすときだけ `shell-worker` に `gh pr merge --squash --delete-branch` を実行させる。
6. Discord に完了報告（自動マージしたか、人間レビュー待ちにしたか）を送る。

## ガードレール（自動マージの安全弁）

以下を全て満たすときだけ自動マージする。

- diff が `context/skills/**` のみ（コード・`.claude/agents/`・README 本体などを含まない）。
- 新規スキル追加、または既存スキルの非破壊的編集のみ。
- CI（`nr validate`）が green。

一つでも外れたら自動マージしない。Discord に「人間レビューが要りそう」と理由を添えて報告し、PR は open のまま停止する。

## 委譲境界

- ふあ自身は `bash` / `gh` / `git` を直接叩かない。repo 操作・PR・マージはすべて `shell-worker` に委ねる。
- `shell-worker` の作業は専用 workspace 内に限定する。workspace 外の読み書き、host secrets、auth files、環境変数 dump、権限昇格を試みない。
- `shell-worker` から返った結果を確認し、Discord には必要な要約・PR URL・完了可否だけを送る。
