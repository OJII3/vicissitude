# コード規約: factory / class パターンの使い分け

## 1. 概要

`packages/` 配下で factory 関数パターン（`createXxx()` が値を返す）と class パターン（`new Xxx()` でインスタンス化）が混在しており、新規コードを書く際にどちらを使うべきかの指針がなかった。本ドキュメントは両者のハイブリッド規約を明文化し、新規コードの判断基準と既存逸脱の移行方針を定める。

本規約の目的:

- 新規コードの種別ごとに採用すべきパターンを一意に決定できるようにする
- 既存多数派を尊重し、全面書き換えコストを避ける
- 値オブジェクト・Port/Adapter・composition-root など、役割が異なるコードに最適なパターンを当てる

## 2. 現状の棚卸し

main ブランチ調査時点（2026-04-05）の統計:

| パターン              | 件数     | 主な用途                                                          |
| --------------------- | -------- | ----------------------------------------------------------------- |
| `class`               | 約 30 件 | Port/Adapter 実装、長寿命ステートフルサービス                     |
| `createXxx()` factory | 約 13 件 | 値オブジェクト builder、composition-root 配線、ステートレスマッパ |

### 既存の逸脱（アダプタなのに factory）

| ファイル                                       | 逸脱内容                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/spotify/src/auth.ts`                 | `createSpotifyAuth` — Adapter だが factory                             |
| `packages/spotify/src/spotify-client.ts`       | `createSpotifyClient` — Adapter だが factory                           |
| `packages/spotify/src/selector.ts`             | `createTrackSelector` — Adapter だが factory（ただしほぼステートレス） |
| `packages/tts/src/aivis-speech-synthesizer.ts` | `createAivisSpeechSynthesizer` — Adapter だが factory                  |

### 継承の使用状況

継承は `AgentRunner` → `DiscordAgent` / `MinecraftAgent` の 1 箇所のみ。class の継承機能はほぼ使われていないが、命名規則（クラス名が Port 実装であることを示す）と DI（コンストラクタで依存注入）のしやすさが class の主な価値として残る。

## 3. 規約

### 3.1 種別ごとの判定表

| 種別                                           | 規約                             | 根拠                                                              |
| ---------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| 値オブジェクト / DTO builder                   | **factory** (`createEpisode` 等) | `new` を付ける意味がない。純粋関数に近く、state を持たない        |
| Port/Adapter 実装                              | **class**                        | 既存多数派。クラス名で Port 実装であることが判別容易、DI しやすい |
| 長寿命ステートフルサービス                     | **class**                        | 既存多数派。複数のメソッドで共有 state を扱うのが自然             |
| composition-root 配線エントリ（facade を返す） | **factory** (`createMemory` 等)  | 複数依存を束ねる一回限りの組み立て。内部で複数クラスを new する   |
| ステートレスマッパ（純粋変換器）               | **factory またはモジュール関数** | state がないので class は冗長                                     |

### 3.2 各種別の特徴と判定基準

#### 値オブジェクト / DTO builder

- 入力値から不変のデータ構造を組み立てて返す関数
- state を持たず、同じ入力に対して同じ出力を返す
- 例: `createEpisode`, `createFact`, `createEmotion`, `createTtsStyleParams`
- `new` に意味がないため factory を採用する

#### Port/Adapter 実装

- Port（抽象インターフェース）に対する具象実装
- コンストラクタで外部依存（DB 接続、API クライアント、設定値）を受け取る
- 例: `SqliteBufferedEventStore`, `OllamaEmbeddingAdapter`, `WsConnectionManager`
- class 名が「この実装は○○の Port を満たす」というシグナルになるため class を採用する

#### 長寿命ステートフルサービス

- アプリケーションのライフサイクルを通じて生存し、内部 state を保持するサービス
- 例: `HeartbeatService`, `SessionStore`, `JobManager`
- 複数のメソッドが共有 state を読み書きするため class が自然

#### composition-root 配線エントリ（facade を返す）

- 複数の class を new し、相互に結線してまとめた facade を返す関数
- 主に `apps/discord/src/bootstrap.ts` から呼ばれる一回限りの組み立てコード
- 例: `createMemory`, `createBotContext`, `createBotConnection`, `createGatewayServer`
- 組み立てが関数の本質であり、返される facade 自体は既存 class の集合なので factory を採用する

#### ステートレスマッパ（純粋変換器）

- 入力を別形式に変換するだけで state を持たない
- 例: `createEmotionToExpressionMapper`, `createEmotionToTtsStyleMapper`
- class にする理由がないため、factory または単純なモジュール関数として書く

## 4. 逸脱の扱い

### 4.1 既存逸脱（Spotify, TTS）の移行方針

以下のアダプタは Port/Adapter 実装に該当するため、**class への移行対象**とする。ただし、移行は本規約策定と切り離し、別 PR で段階的に実施する。

| 対象                           | 現状    | 移行後                         |
| ------------------------------ | ------- | ------------------------------ |
| `createSpotifyAuth`            | factory | `class SpotifyAuth`            |
| `createSpotifyClient`          | factory | `class SpotifyClient`          |
| `createTrackSelector`          | factory | `class TrackSelector`          |
| `createAivisSpeechSynthesizer` | factory | `class AivisSpeechSynthesizer` |

移行時の注意:

- 呼び出し元（composition-root および関連テスト）の更新が必要
- 仕様テスト（`*.spec.ts`）が通ることを移行の合格条件とする
- ユニットテスト（`*.test.ts`）は実装詳細に密結合しているため、移行と同時に書き換えてよい

### 4.2 全面統一を採らない理由

- **全面 factory 化**: 30+ class の書き換えコストに見合わない。DI の明示性と Port 実装識別性を失う
- **全面 class 化**: 値オブジェクトに `new` を強いるのが不自然。composition-root の配線関数は class 化すると単なる「コンストラクタのラッパ」になり冗長

## 5. 判定フローチャート

新規コードを書くときの判断手順:

1. **state を持つか？**
   - No → **2 へ**
   - Yes → **4 へ**
2. **外部依存（DB, API, 設定値）をコンストラクタで受け取るか？**
   - No → **factory またはモジュール関数**（値オブジェクト builder / ステートレスマッパ）
   - Yes → **3 へ**
3. **複数の class/service を束ねる一回限りの組み立てか？**
   - Yes → **factory**（composition-root 配線エントリ）
   - No → **class**（Port/Adapter 実装）
4. **長寿命でアプリケーション全体から共有されるか？**
   - Yes → **class**（長寿命ステートフルサービス）
   - No → 設計を再検討する（短命な state 持ちオブジェクトは通常値オブジェクトに分解できる）

### 判定例

- `createEpisode(raw)` が input から Episode を組み立てて返す → state なし、依存なし → **factory**
- `SqliteBufferedEventStore` が SQLite Database をコンストラクタで受け取り、複数メソッドで使う → state あり、依存あり、Port 実装 → **class**
- `createMemory({ db, embedder, logger })` が複数の class を new して facade を返す → 配線エントリ → **factory**
- `createEmotionToTtsStyleMapper()` が emotion を TtsStyleParams に変換するだけ → state なし → **モジュール関数 or factory**
