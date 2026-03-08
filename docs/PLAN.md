# PLAN.md

## Project Overview

このプロジェクトでは、既存の Discord 雑談 AI エージェント `vicissitude` に Minecraft プレイ能力を追加する。

## Goal

既存の「人間っぽい雑談 AI」の人格と記憶機能を維持したまま、Minecraft 上で基本的な行動を行えるようにする。

最重要目標は以下の両立:

1. Discord 上で自然に雑談できること
2. Minecraft 上で簡単な自律行動ができること
3. 情報過多でエージェントがパンクしないこと

## Existing Architecture

既存システムにはすでに以下がある:

- Discord bot
- 記憶機能
- opencode をバックエンドとした LLM agent 実行
- MCP ベースのツール呼び出し構成
- event-buffer / memory / ltm / schedule などの MCP サーバー

つまり、今回やるべきことはエージェント基盤の総入れ替えではなく、Minecraft を新しい MCP ツール群として追加すること。

## High-Level Direction

方針は「人格は 1 つ、内部は分業」。

外から見える人格は既存の Discord 雑談エージェントのまま維持する。
一方で Minecraft の状態や行動は、そのまま巨大な文脈として LLM に渡さず、MCP ツールと要約レイヤーを通して扱う。

重要な考え方:

- 会話人格は 1 つに保つ
- Minecraft の低レベル操作は mineflayer に任せる
- LLM は高レベル判断に集中させる
- 状態は常に要約して渡す
- 毎 tick LLM に判断させない
- イベント駆動で考える

## Primary Technical Plan

### 1) Minecraft integration via MCP server

新しい `minecraft` MCP server を追加する。

この MCP server は内部で mineflayer bot を保持し、Minecraft サーバーへの接続・移動・採集・クラフトなどを担当する。

LLM/opencode は直接 Minecraft を制御しない。
代わりに MCP ツールとして高レベル API を呼ぶ。

### 2) Keep opencode as the current LLM backend

opencode は現時点では置き換えない。
既存の agent loop と MCP 呼び出し構成をそのまま活かす。

今回の目的は新しいエージェントフレームワークへの移行ではなく、Minecraft 能力の追加である。

### 3) Prevent context overload

Minecraft の生データをそのまま LLM に流さない。

例えば以下のような raw 情報を直接毎回渡すのは避ける:

- 詳細な周辺ブロック一覧
- 毎 tick の座標変化
- すべての視界情報
- 長大なイベントログ

代わりに、要約済み状態だけを LLM に見せる:

- 現在地の概要
- 体力 / 空腹
- 時間帯（昼 / 夜）
- 近くの危険
- インベントリの重要アイテム
- 現在の目標
- 直近の重要イベント

## Scope of First Implementation

最初の実装では、複雑な完全自律ではなく「基本行動 + 雑談との共存」を目指す。

### Initial supported abilities

- Minecraft サーバーへの接続
- 状態取得
- 指定プレイヤーへの追従
- 指定地点への移動
- 木材や簡単なブロックの採集
- 基本的なクラフト
- 道具装備
- ベッドで睡眠
- Minecraft 内チャット送信
- 直近イベント取得

### Initial behavior style

最初は「高度な長期計画」よりも「短い行動の安定実行」を優先する。

例:

- プレイヤーについてくる
- 木を切る
- 夜になったら寝ようとする
- 危険なら軽く退避する
- Discord 上で今の状況を自然に説明する

## Non-Goals for Now

今回の初期実装では以下は目標にしない:

- 完全自律の長期サバイバル
- 高度な建築計画
- 複雑な戦闘 AI
- Minecraft の全知覚を使ったリアルタイム推論
- エージェント基盤全体の刷新
- マルチエージェントフレームワークの新規導入

必要以上に複雑化しないこと。

## Suggested Internal Separation

内部責務は以下のように分ける:

### A) Conversation persona layer

既存の Discord 雑談人格。
ユーザーへの返答文はここが最終的に生成する。

### B) Minecraft tool layer

mineflayer を使って実際のゲーム操作を行う層。
移動・採集・クラフトなどの低レベル行動を担当する。

### C) Minecraft state summarization layer

Minecraft の生状態を、LLM が扱いやすい短い要約へ変換する層。

### D) Event-driven decision layer

重要イベントが起きたときだけ、LLM が再判断する。
毎フレーム判断はしない。

## Proposed MCP API

初期段階では、以下のようなツールを想定する:

- `observe_state`
- `follow_player`
- `go_to`
- `collect_block`
- `craft_item`
- `place_block`
- `equip_item`
- `sleep_in_bed`
- `send_chat`
- `get_recent_events`

必要なら追加してよいが、まずは最小限で始めること。

## Important Design Constraints

### 1) Do not overload the LLM

Minecraft 状態を大量に渡しすぎないこと。

### 2) Do not replace existing architecture unnecessarily

既存の opencode + MCP + memory 構成は活かすこと。

### 3) Keep the persona unified

外向きの人格は 1 つに保つこと。
内部事情をそのまま喋らせないこと。

### 4) Favor robust tool execution over clever prompting

賢いプロンプトより、安定したツール実行を優先すること。

### 5) Prefer event-driven updates

状態変化や失敗時のみ再判断する。
常時思考させない。

## Concrete First Tasks

優先順で以下を進める:

1. `minecraft` MCP server の土台を作る
2. mineflayer bot を起動・接続できるようにする
3. `observe_state` を実装する
4. `follow_player` / `go_to` を実装する
5. `collect_block` を実装する
6. 重要イベントのログを整備する
7. LLM に渡す Minecraft 状態要約を作る
8. 既存 agent から Minecraft ツールを呼べるようにする
9. Discord 雑談と Minecraft 状況説明の整合を取る

## Implementation Preference

- TypeScript / Bun ベースを維持する
- 既存 repo の構造を尊重する
- まず動く最小構成を作る
- 抽象化は必要最小限にする
- 先に interface を完璧化するより、最小の end-to-end 動作を優先する

## Definition of Success

初期成功条件は以下:

- Discord から話しかけると、既存人格として自然に返答できる
- Minecraft に接続した bot が最低限の行動を実行できる
- bot が現在の Minecraft 状況を簡潔に説明できる
- 実装が過度に複雑化していない
- コンテキスト過多で応答品質が崩れていない

## Summary

この作業の本質は、新しい巨大なエージェント基盤を導入することではない。
既存の雑談 AI 基盤を維持しつつ、Minecraft を MCP ツールとして追加し、知覚と行動を整理して扱えるようにすること。

最初は小さく始め、安定してから拡張すること。
