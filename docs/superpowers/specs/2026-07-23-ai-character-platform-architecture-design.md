# AIキャラクター基盤 全体アーキテクチャ設計

- 日付: 2026-07-23
- 状態: 文書レビュー承認済み
- 対象: AIキャラクター基盤 要求ベースライン v0.1
- 実装対象: Vicissitude `develop`

## 1. 目的

本書は、Discordコミュニティの中で継続的に存在するAIキャラクター基盤を、要求ベースライン v0.1に基づいて全面再構築するための全体設計を定める。

本書で確定する範囲は次のとおりである。

- システム境界と実行構成
- 中核モジュールの責務
- 永続データの正本
- Discordイベントから外部作用までの処理フロー
- 人格、状態、関係、興味、記憶の分離
- pi agent、LLM provider、toolの交換境界
- 権限、監査、冪等性、障害処理
- 評価、運用、段階的な実装順
- 旧Vicissitudeとluna-chatの再利用分類

具体的な最初のキャラクター人格と、各Phaseの詳細アルゴリズム・DDL・公開APIは、後続の個別設計で定める。

## 2. 確定した前提

| 項目 | 決定 |
| --- | --- |
| 再構築方針 | 新しい境界で全面再構築し、旧資産は選別して再利用する |
| 技術選定 | 言語・実行基盤を要求から再選定する |
| 基本技術 | TypeScript、Node.js 24、Nix、PostgreSQL |
| 本番環境 | 単一NixOS/Linuxホスト |
| Discord | 1サーバー、1キャラクター。データには `guild_id` と `character_id` を保持する |
| 旧データ | 旧人格・記憶・sessionを移行せず、完全に新規開始する |
| 人格設計 | 具体的人格は別工程とする |
| agent runtime | `@earendil-works/pi-agent-core` を最初のadapterにする |
| model runtime | `@earendil-works/pi-ai` を最初のadapterにする |
| shell | 専用非特権Unixユーザーとしてホスト上で実行する |
| shell承認 | 個別承認を要求せず、Unix権限内では自動実行する |
| リリース | 段階化する。Phase 1完了後、production CharacterDefinition登録済みならメンション応答を稼働可能にする |
| shadow | 実装するが、初回投稿前の必須gateにはしない |

pi packageは2026-07-23時点の現行namespaceを使用する。旧 `@mariozechner/*` packageはdeprecatedであり、設計上の依存先にしない。

## 3. 現状調査

### 3.1 Vicissitude

現 `develop` の `f6c975f` は、旧実装約86,000行を削除した再構築用の状態である。実体はほぼ `flake.nix` の雛形だけであり、要求を満たす実行可能なアプリケーションは存在しない。

削除前実装は次の場所から参照できる。

- Git branch `main`、commit `9c98bec`
- `/home/ojii3/src/github.com/ojii3/vicissitude.bak`

旧実装にはDiscord gateway、OpenCode adapter、memory、scheduler、observability、SQLite store、MCP、Minecraft、Web UIがある。一方で、非永続queue、外部作用台帳の欠如、scope権限漏れ、memory provenance不足、model routingとshadowの欠如、循環依存など、要求ベースラインと合わない部分が多い。

### 3.2 luna-chat

参照対象は `shun-shobon/luna-chat` である。Ports and Adapters、Discord投稿の遅延batch、typing待機、session調停、Codex protocol adapter、MCPを副作用境界にする考え方は参考になる。

一方で、構造化長期記憶、外部作用台帳、十分なoutbound権限、管理CLI、shadow、metricsがない。任意channelへのDiscord作用、絶対pathのファイル共有、passwordless sudoなども本要求には適合しない。

リポジトリrootの `LICENSE` が確認できないため、権利関係が明確になるまでは設計参考に限定し、コードを直接コピーしない。

## 4. 設計原則

1. キャラクターの永続状態をagent runtimeのsessionに置かない。
2. Discord、pi、provider、PostgreSQLの型を中核domainへ漏らさない。
3. 受信の受付、判断の完了、外部作用の完了を別状態として追跡する。
4. LLMの自由文ではなく、型付きの判断とeffectを境界にする。
5. 人格を発話styleではなく、認知から表現までの全段階へ適用する。
6. 沈黙、後回し、内部処理を通常の行動として扱う。
7. 外部作用は実行前に永続化し、権限を実行直前にも再確認する。
8. 検索索引と要約を記憶の正本にしない。
9. metrics、監査記録、生のLLM thinkingを混同しない。
10. 小規模運用に不要な分散システムを導入しない。

## 5. 実行アーキテクチャ

### 5.1 Process topology

```text
Discord
  |
  v
discord-gateway ----- PostgreSQL ----- cognition-worker ----- pi agent / LLM providers
  |                       |                    |
  |                       |                    v
  |                       |               shell-worker
  v                       v               dedicated Unix user
Discord effects       admin CLI
```

### 5.2 実行単位

#### discord-gateway

- Discord gateway eventを受信する。
- Discord固有DTOをcanonical eventへ正規化する。
- eventと最初のjobを同じtransactionで保存する。
- typing状態を扱う。
- 権限承認済みのDiscord effectだけを実行する。
- Discord tokenを持つ唯一のprocessとする。

#### cognition-worker

- 短時間batchとconversation clusterを構築する。
- 宛先推定、関連記憶取得、行動選択、発話生成を行う。
- 記憶抽出、統合、忘却、興味・関係・状態更新を行う。
- model routing、pi agent実行、Web調査、artifact生成を担当する。
- 自律活動、feedback整理、週次評価を実行する。

#### shell-worker

- 専用非特権Unixユーザーで動作する。
- 専用workspaceを持つ。
- cognition-workerからの型付きrequestをlocal IPCで受け取る。
- Discord token、LLM credential、管理DB権限を持たない。
- command、cwd、environment、開始・終了、exit code、stdout/stderr要約を監査する。
- 個別承認なしで、Unixユーザーに許可された範囲の操作を実行する。
- shell自身はDiscordへ投稿しない。

#### admin CLI

- DBへ任意SQLを発行せず、application serviceを呼ぶ。
- 通常processが停止中でも、必要な管理操作を実行できる。
- memory、adaptation、system state、shadow、effect、migrationを管理する。
- 全変更に管理actorと理由を付ける。

### 5.3 PostgreSQL

PostgreSQLを次の正本にする。

- Discord eventと現在状態の投影
- durable jobとlease
- decision run
- external effect ledger
- character state、relationship、interest
- canonical memoryとprovenance
- model call、audit、feedback、adaptation
- channel capabilityとsystem control
- schema migration履歴

Redis、NATS、KafkaはMVPで導入しない。job claimはPostgreSQL transactionと `FOR UPDATE SKIP LOCKED` 相当で実装する。

## 6. Module boundary

| Module | 責務 |
| --- | --- |
| `contracts` | Platform非依存のevent、decision、effect、model result、tool contract |
| `conversation` | batch、cluster、participant、reply関係、宛先推定 |
| `character` | CharacterDefinition、短期状態、関係、興味、好み、availability |
| `decision` | 行動候補、hard rule、LLM判断、発話予算、理由コード |
| `memory` | 人物・episode・community・self memory、検索、統合、忘却 |
| `agent-runtime` | 複数turn agent実行のportとpi adapter |
| `model-runtime` | 単発の構造化推論portとpi-ai adapter |
| `effects` | capability判定、ledger、Discord・shell・Web effect |
| `autonomy` | 内部目的、活動job、継続中の関心 |
| `governance` | feedback候補、適応承認、履歴、rollback |
| `evaluation` | 固定scenario、shadow、差分、週次review |
| `observability` | audit summary、metrics、structured log、trace context |

依存方向は次の一方向を原則とする。

```text
contracts/domain -> application use cases -> adapter -> process composition
```

Import制約をlintで機械的に検証する。MCPは必要な場合もtransport adapterとして扱い、domainやmemoryからimportしない。

## 7. Canonical eventと会話文脈

### 7.1 Canonical event

Discord eventは最低限、次を保持する。

- `event_id`
- `schema_version`
- Discord event種別とexternal ID
- guild、channel、thread
- actorとactor種別
- mention対象
- reply先
- event発生日時と受信日時
- attachmentとlink
- reaction
- create、edit、delete状態
- 元Discord message参照
- 30日後の `expires_at`

編集・削除は元rowを上書きせず、新しいevent versionとして保存する。現在状態はeventから投影する。

外部event IDとversionにはunique制約を置く。Gateway再送や再接続で同じeventを受信しても、jobを重複生成しない。

### 7.2 Short batch

同じ会話scopeの短時間連投は、設定可能な小さな待機窓でbatch化する。追加投稿とtyping中のユーザーがいる場合は上限まで待つ。待機時間、最大batch数、最大待機時間はPhase 2の会話scenarioで決める。

### 7.3 Conversation cluster

同一channel内の並行会話を区別するため、次を組み合わせてclusterを推定する。

- Discord thread
- reply edge
- mentionと名前呼び
- 直前の参加者集合
- 時間的近さ
- 話題の類似度
- 発話styleと問いかけ

threadとreplyは強い証拠として扱う。確信度が低いcluster統合は避け、複数候補を保持できるようにする。

## 8. 認知と行動選択

認知は一つの巨大promptではなく、監査可能な段階へ分ける。

```text
event feature extraction
  -> conversation cluster
  -> addressee inference
  -> memory / relationship / state retrieval
  -> action selection
  -> utterance generation when needed
  -> external effect
```

### 8.1 宛先推定

候補は次のいずれかとする。

- キャラクター自身
- 特定ユーザー
- 複数ユーザー
- channel全体
- 不明

判断にはreply、mention、直前会話、参加者、関係、口調を使う。候補と確信度を `decision_runs` に保存する。低確信度では強い介入を避ける。

### 8.2 行動

行動種別は次を正規形とする。

- `silence`
- `reaction`
- `post`
- `reply`
- `mention_post`
- `create_thread`
- `share_artifact`
- `internal_only`
- `defer`

行動選択には最低限、次を渡す。

- 明示mention
- 宛先候補と確信度
- 会話流速と参加人数
- キャラクターの直近発言量
- 話題への興味
- ユーザーとの関係
- 現在状態とavailability
- 発言の新規性
- 割り込みcost
- channel capabilityと傾向
- 承認済みadaptation

出力は自由文ではなく、行動種別、対象、確信度、理由コード、発話予算、必要toolを持つ構造化結果とする。

### 8.3 Mention

明示mentionは高優先度jobを開始し、通常の `silence` 候補から外す。正常稼働時は10から30秒以内に短い応答または一次反応を返す。

観察が許可されていないchannelでも、明示mentionは `mention_only` eventとして取り込める。このeventには対象messageのID、guild、channel、thread、actor、時刻、本文、mention、reply参照、attachment metadataだけを保存し、同じchannelの履歴は取得しない。添付内容は、mentionしたmessageに含まれるものだけをそのrunで参照できる。

`mention_only` eventは通常eventと同じく30日で削除し、人物・community・relationship・interestのmemory抽出対象にしない。応答判断とauditにだけ利用する。観察とmention応答の両方が無効なchannelでは本文を永続化せず、contentを含まない受信counterだけを記録する。

全体停止、管理者が無効化したmention応答、Discord権限不足はhard constraintとして優先する。

### 8.4 発話生成

発話生成は内部分析と分離する。

- 通常の初回応答は短い会話文を基本とする。
- 内部調査量をそのままDiscordへ出さない。
- 詳細成果物を作る前に原則確認する。
- 確信度と記憶の古さを表現へ反映する。
- 不明な内容を事実として補完しない。
- 人格により拒否、不機嫌、素っ気なさ、冗談を許容する。
- Discordへの通常発話は日本語を必須とする。引用、code、固有名詞、URL、ユーザーが明示的に求めた原文表記は例外とする。

長時間調査では一次反応runと最終応答runを分ける。

## 9. Character model

### 9.1 CharacterDefinition

CharacterDefinitionはversion付きの永続定義とし、次を分離して表す。

- 自己認識と価値観
- 注意を向けやすい対象
- 解釈傾向
- 興味と記憶の重み
- 感情の動き方と減衰
- 発言参加傾向
- 表現style
- 固定方針と権限境界

人格versionを変更しても、memory、relationship、interest、promise、継続中の関心は維持する。

### 9.2 Awarenessとrelationship

人物ごとに次のawareness stageを持つ。

- `unseen`: 観測記録がない
- `observed`: サーバー内で観測したが会話していない
- `interacted`: 会話したことがある

relationshipは根拠event、確信度、最終更新日時を持つ。単発eventによる急変を避けるため、更新量上限と根拠件数を設ける。

### 9.3 State

短期状態はversion付きstate snapshotとして保持し、人格定義ごとの減衰規則でbaselineへ戻す。具体的なstate軸と係数は人格設計で決める。

睡眠・不在に相当する `availability` と、process・provider・DBの `system_health` は別modelにする。

### 9.4 Interestとpreference

interestとpreferenceは次を持つ。

- score
- confidence
- evidence count
- first observed / last observed
- decay policy
- source memory IDs

反復経験によって緩やかに更新し、一度の反応で固定しない。

## 10. Memory architecture

### 10.1 Canonical memory

すべての長期記憶は共通envelopeを持つ。

```text
memory_id
schema_version
kind: person | episode | community | self
content
occurred_at / observed_at / last_confirmed_at
importance / confidence
status: active | ambiguous | invalid
source event IDs / Discord references
supersedes / merged_from
created_by / updated_by
```

人物記憶、episode記憶、community記憶、self記憶は、kind固有の構造化payloadを持つ。

### 10.2 Provenance

可能な限り次を出典として保持する。

- canonical event ID
- Discord message、guild、channel、thread、actor
- 引用またはsource span
- 抽出日時
- extractor、provider、model、prompt version
- confidence

Discord上でsourceが削除された場合は `unavailable` として扱い、存在するように見せない。

### 10.3 Index

PostgreSQL全文検索を最初の検索索引とする。検索用要約とembeddingは派生物であり、canonical memoryから再構築可能にする。

pgvectorは初期必須にしない。固定scenarioで全文検索だけでは不足することを確認した場合に追加する。

### 10.4 Retrieval

検索順位は次を組み合わせる。

- query relevance
- importance
- confidence
- time decay
- relationship
- current validity
- surveillance penalty

古い記憶は詳細と確信度を落とし、現在も有効な事実として無条件に扱わない。検索したこと自体は `last_confirmed_at` を更新する根拠にしない。

### 10.5 Consolidationとforgetting

- eventからepisodeを作る。
- 反復する人物・community情報を統合する。
- 矛盾する事実は上書きせず、revisionまたは曖昧状態にする。
- 古い詳細は要約・曖昧化できる。
- invalidate、merge、supersedeを履歴として残す。
- correctionは新revisionを作り、旧revisionを無効化する。
- deleteはmemory本文と派生索引を物理削除し、内容を含まない管理auditだけを残す。

### 10.6 Retention

- raw Discord eventは原則30日保持する。
- 30日後は必要な情報だけをcanonical memoryとして保持する。
- source messageがDiscordに残る場合は権限確認後に再取得できる。
- retention jobは削除件数、失敗、最終成功時刻を監査する。

## 11. Modelとpi agent

### 11.1 Runtime port

推論契約を2種類に分ける。

| Port | 用途 |
| --- | --- |
| `ModelRuntime` | 宛先推定、記憶抽出、行動選択、評価などの短い構造化推論 |
| `AgentRuntime` | 調査、複数tool利用、artifact生成などの複数turn実行 |

piのmessage配列、session、thinking blockは永続状態の正本にしない。run開始時にPostgreSQLの状態からcontextを組み立て、pi eventを共通eventへ変換する。

### 11.2 Model route

用途ごとに次を設定する。

- primary provider / model
- fallback順
- timeoutとretry policy
- token・金額上限
- priorityと同時実行数
- structured output失敗時の扱い
- shadow candidate
- policy version

用途には最低限、addressee、memory extraction、action、speech、research、evaluationを含む。

provider固有responseはadapter内に閉じる。`model_calls` には用途、成否、latency、token、推定cost、fallback、structured output failureを保存する。

### 11.3 Agent数とcontrol

論理agent数を固定しない。job単位で必要なruntimeを構成し、worker側でrate limit、budget、priority、cancellationを制御する。

## 12. Toolと外部作用

### 12.1 Capability policy

すべてのtoolは次を宣言する。

- subject
- action
- resource
- side-effect class
- idempotency strategy
- required capability
- timeoutとbudget

toolをpiへ渡す前と、実行直前の二段階で権限を確認する。shadow runには外部作用toolを渡さない。

### 12.2 Channel capability

channelごとに次を独立設定する。

- observe event
- respond to mention
- join conversation spontaneously
- start topic spontaneously
- add reaction
- create thread
- share file or artifact
- share external link

管理者slash commandはキャラクターtoolとは別のinteraction handlerで認証し、同じapplication serviceを呼ぶ。

### 12.3 Discord effect

Discord effectには最低限、次を含める。

- effect ID
- decision run ID
- effect slot
- channel / message target
- payload
- capability decision
- state
- external resource ID
- attemptとerror

effect stateは `planned -> executing -> succeeded | failed | unknown` とする。`planned` のeffect ledger rowがoutboxを兼ね、Gatewayまたは対象workerがtransaction内でclaimする。独立したoutbox tableや二重の状態機械は設けない。

同一 `run_id + effect_slot` にunique制約を置く。Discord message作成では、effect IDから決定的に導出したDiscord制約内のnonceを使用する。reactionなど冪等なAPIは安全にretryできる。

非冪等な作用が通信切断で結果不明になった場合は `unknown` とし、自動retryしない。管理CLIで外部状態を照合して確定する。

### 12.4 Shell

shell invocationは開始前にeffect ledgerへ記録する。同じeffectの自動二重実行を禁止する。

実行時には次を適用する。

- `cwd` を専用workspace配下に限定する。
- `ProtectSystem=strict`、`ProtectHome=true`、`NoNewPrivileges=true`、`PrivateTmp=true` 相当のsystemd sandboxを適用する。
- 書き込みをworkspaceとartifact stagingだけに限定する。
- application data、credential、他serviceのstate directoryをfilesystem namespaceから隠す。
- Nixで固定したPATHだけを渡し、利用可能なcommand classをdeployment manifestで監査できるようにする。
- shell processからのnetwork egressを既定で禁止する。network取得は12.6の型付きWeb toolを使う。
- canonical path検証
- Discord共有時のsymlink脱出拒否
- command timeout
- stdout/stderr上限
- process同時実行上限
- credential分離

ユーザー決定により、上記境界内の操作は個別承認なしで自動実行する。

### 12.5 Artifact

artifact metadataはPostgreSQLに保存し、実体は単一ホスト上のversion付きartifact repositoryへ置く。Discordへのfile、link、thread共有は別effectとして再認可する。共有には対象channelのfile・artifactまたはexternal link capabilityと、artifact自体のaccess controlの両方を要求する。

### 12.6 Web tool

Web取得はshell networkとは分離した型付きread-only toolとする。

- `https` を既定とし、redirectごとに宛先を再検証する。
- loopback、link-local、private address、Unix socket、local fileを拒否する。
- response size、content type、redirect回数、timeoutを制限する。
- provider credentialやDiscord tokenをrequestへ転送しない。
- source URL、取得日時、status、content hashを結果に付ける。
- 外部serviceへのwrite操作はWeb取得と分け、個別のeffect contractとして定義する。

## 13. 自律活動とgovernance

### 13.1 自律活動

interest、継続中の関心、community eventから内部jobを作れるようにする。

成功条件は次を含み得る。

- 調査が完了した
- 理解が更新された
- 記憶が整理された
- 興味が深まった

Discord投稿やユーザー反応は成功条件にしない。活動結果はself memoryへ保存し、投稿するかどうかは通常のaction selectionへ戻す。

### 13.2 Feedback

一般ユーザーの通常発言からfeedback candidateを検出する。候補は直接policyへ反映しない。

一定期間ごとに候補を統合し、管理者がapprove、edit、rejectできるようにする。

### 13.3 Adaptation

承認済みadaptationはversion付きで保存し、変更前後、理由、根拠、承認者、時刻を監査する。rollbackは過去versionを再適用する新しい変更として記録する。

自動更新を許容するのは次の範囲である。

- 発言頻度と量
- reaction傾向
- 会話参加傾向
- ユーザーごとの距離感
- memory importance判断
- interestとpreference

中核人格、価値観、自己認識、主要世界観、権限、安全制約、管理者固定方針は自動変更しない。

## 14. 管理CLI

最低限、次のcommand体系を提供する。

```text
vicissitude memory person search|show|correct|invalidate|delete
vicissitude memory episode search|show|correct|invalidate|delete
vicissitude feedback list
vicissitude adaptation approve|reject|history|rollback
vicissitude system stop|drain|resume
vicissitude autonomy stop|resume
vicissitude shadow start|stop|status
vicissitude effect inspect|reconcile
vicissitude migration status|apply
```

`system stop` は新規runと未開始effectを停止する。`drain` は新規job取得を止め、現在の安全な境界まで待つ。`autonomy stop` はメンション応答を維持し、自発活動と自発発言だけを停止する。

## 15. Auditとobservability

### 15.1 Audit summary

各decision runに次を保存する。

- 主な文脈とconversation cluster
- 宛先候補と確信度
- 選択行動と理由コード
- 使用memory ID
- toolとeffect
- provider、model、fallback
- latency、token、cost
- errorと縮退動作
- character、channel policy、adaptation version

LLMの生のthinkingは保存しない。全文promptやresponseを通常logへ出さない。

### 15.2 Telemetry

OpenTelemetry互換のlog・metricsを出し、Grafana CloudへOTLP送信できるadapterを用意する。

共通correlation keyは次とする。

- `event_id`
- `job_id`
- `run_id`
- `effect_id`
- `model_call_id`

最低限、次を集計する。

- 発言、reaction、自発発言
- mention応答率とlatency
- 発言長分布
- provider/model別latency、失敗率、token、cost
- structured output失敗
- fallback
- job backlogとlease timeout
- effectのfailed、unknown、duplicate prevention

### 15.3 週次report

週次reportはauditとmetricsから生成し、次を含める。

- 運用状況
- 自然・不自然候補
- 入りすぎた場面と参加してよさそうだった沈黙
- 怪しい宛先推定
- 監視的なmemory利用
- 古い情報、知ったかぶり、長文
- interestとpreferenceの急変
- adaptation候補

LLM評価だけで自動修正しない。

## 16. 障害処理

### 16.1 Modelとtool

model失敗時はrouting policyに従ってfallbackする。すべて失敗してもDBが正常なら、CharacterDefinition versionに紐づく短い縮退応答をeffectとして記録できる。

tool失敗はLLMへ構造化結果として返し、必要なら別行動を選ぶ。外部作用の成否を推測で補完しない。

### 16.2 Database

DB障害時はevent、decision、effectを追跡できないため、Discordへ新しい外部作用を行わない。GatewayはhealthをdegradedにしてDiscord sessionを切断し、永続化できないeventの受信継続を避ける。

復旧後はDiscord gateway resumeと、許可channelのmessage履歴取得で回収可能なmessageだけを補完する。typing、削除通知など再取得できないeventを完全復元できるとはみなさない。欠落の可能性がある時間帯とevent種別を `ingestion_gap` auditとして記録し、架空のeventを生成しない。

### 16.3 Character continuity

ユーザーへ返す縮退応答にstack trace、provider名、HTTP statusなどを直接含めない。技術情報はauditと運用alertへ送る。

availabilityによる睡眠・不在とsystem failureを別状態として扱う。

## 17. Deployとmigration

### 17.1 Nixとsystemd

NixでNode.js、依存、build、migration CLI、systemd unitを固定する。

Gateway、cognition、shellには別Unix userと別credentialを与える。credentialは必要なprocessだけが読めるようにする。shell unitには12.4のfilesystem・process・network制約を適用する。

### 17.2 Update

通常更新は次の順序で行う。

1. workerをdrain状態にする。
2. 実行中runを安全な境界まで待つ。
3. effectを `succeeded`、`failed`、`unknown` のいずれかへ確定する。
4. processを停止する。
5. backupを確認する。
6. migrationを明示実行する。
7. 新versionを起動する。
8. healthとreadinessを確認してjob取得を再開する。

数分程度の停止を許容する。

### 17.3 Migration

各migrationはversion、checksum、適用日時を持つ。起動時に暗黙適用しない。

migration前にPostgreSQL backupまたはsnapshotを必須にする。大規模変更では完全な後方互換を要求しないが、canonical memory本文とprovenanceを優先して維持する。

## 18. Testとevaluation

### 18.1 決定的test

LLMを使わず、実PostgreSQLを一時起動して次を検証する。

- channel capability
- mention detection
- event deduplication
- retention
- time decay
- provenance
- schema migrationとbackup restore
- model routing
- tool capability
- effect idempotency
- stop、drain、resume
- worker crashとlease recovery
- effect実行前後のcrash

pi adapterはfaux providerでcontract testを行う。

### 18.2 固定会話scenario

要求ベースライン14.2の全scenarioを保持する。

- 完全な初対面
- 観測済みだが会話は初めて
- 暗黙的な宛先
- 複数会話の混在
- 昨日のmemory
- 半年前の曖昧なmemory
- preferenceの反復観測
- interestの形成
- 詳細調査の依頼
- 未知の内容への質問
- 強い冗談やからかい
- 誤った前提を含む会話

完全一致ではなく、宛先、行動、memory、時間表現、知ったかぶり、発言量、character性、不確実性、日本語逸脱で評価する。

定量thresholdは、Phase 2で人間がlabel付けしたscenario corpusを作成した後に固定する。mention detection、権限、重複防止など決定的性質は100%を要求し、LLM品質項目はmodel・persona変更を比較できる基準値と下限をversion管理する。

### 18.3 Shadow

active版とcandidate版へ同じcanonical eventを渡す。candidate側には外部作用toolを渡さない。

次を比較する。

- 発言・沈黙
- 宛先推定
- 発言候補
- memory利用
- latency
- tokenとcost
- active版との差

sampling、予算上限、cache、途中停止を設定できるようにする。

## 19. 再利用分類

### 19.1 そのまま再利用候補

要求ベースのcontract testに合格した場合だけ、次のpure logicを移植候補とする。

- `packages/memory/src/search-core.ts` のRRF
- `packages/memory/src/vector-math.ts`
- `packages/scheduling/src/heartbeat-helpers.ts` のdue判定
- 対応する仕様testとtest fixture

### 19.2 契約を書き直して利用

- FSRSのtime decay知見
- conversation segmentation
- memory consolidationの責務分離
- namespaceとscope IDの知見
- observability label
- strict config validation
- OpenCode event handlingで得たcancel、stream disconnect、side-effect中断の知見

### 19.3 設計参考のみ

- luna-chatのPorts and Adapters
- 遅延batchとtyping待機
- channel session調停
- agent textを直接送らずtoolを副作用境界にする考え方
- config fail-fastとcron hot reload

### 19.4 破棄

- 旧 `AgentRunner`
- 非永続message queue
- `event_buffer` の破壊的dequeue
- OpenCode sessionを中核にする構成
- MCP god package
- 旧personaと旧memory data
- 旧shell実行方式
- Web、avatar、TTS、Minecraft、DM
- luna-chatのCodex固有実装、XML風入力、outbound権限、file path処理

### 19.5 新規実装

- canonical eventとconversation cluster
- addressee inferenceとdecision pipeline
- PostgreSQL jobとeffect ledger
- provenance付きcanonical memory
- model routerとpi adapter
- channel capability
- admin CLI
- feedback、adaptation、rollback
- shadowと週次report
- NixOS serviceとmigration運用

## 20. 段階ロードマップ

Phase途中で稼働できるが、Phase 5完了までは要求ベースライン上のMVP完成とは扱わない。

### Phase 1: Durable Spine

- Node.js、TypeScript、Nix、PostgreSQLのproject基盤
- canonical event、deduplication、channel capability
- durable job、decision run、effect ledger、audit
- pi model/agent adapterとmodel call計測
- admin system controlとmigration
- 最小CharacterDefinition contractとtest fixture
- mentionへの短い応答とCharacterDefinitionに定義された障害応答

主な要求: FR-101、FR-102、FR-303、AR-*、MR-101からMR-106、OR-101からOR-105、CR-*、AC-10、AC-11。

Phase 1のfixtureはruntime契約を検証するための最小定義であり、本番人格ではない。本番Discordへの投稿は、独立した人格設計で承認したproduction CharacterDefinitionを登録した後に限る。詳細な認知・関係・感情特性はPhase 2の本番稼働前までに追加承認する。

### Phase 2: Conversation Cognition

- short batchとtyping待機
- conversation clusterとaddressee inference
- silence、reaction、reply、post、defer
- 初対面とobserved state
- 短い発話、詳細確認、一次反応と最終応答
- 固定会話scenarioの基礎corpus

主な要求: FR-103、FR-104、FR-201からFR-405、FR-601、FR-603、FR-604、AC-01、AC-03、AC-04、AC-08、AC-09。

### Phase 3: Memory and Continuity

- person、episode、community、self memory
- provenance、retention、forgetting、consolidation
- relationship、state、interest、preference
- memory検索・修正・無効化・削除CLI
- model/provider交換で状態が残ることの検証

主な要求: DR-*、FR-602、AC-02、AC-05、AC-06、AC-07、AC-12、AC-13、AC-14。

### Phase 4: Autonomy and Governance

- shell worker、Web調査、artifact
- file、link、thread共有
- autonomous activityとself memory
- feedback candidate、adaptation、rollback
- system/autonomy control
- weekly report

主な要求: FR-404、FR-406、FR-501からFR-503、FR-701からFR-706、管理CLI、週次振り返り要件。

### Phase 5: Evaluation and Hardening

- 全固定scenario
- shadow、sampling、budget、diff
- Grafana Cloud接続
- backup/restore、drain update、fault injection
- 全要求IDとACのtraceability review

主な要求: MR-107、MR-108、OR-106からOR-110、評価要件、AC-15、NFR-*。

## 21. 要求traceability

| 要求群 | 設計上の対応 | 主Phase |
| --- | --- | --- |
| P-01からP-03 | 認知pipeline、CharacterDefinition、内部分析と発話生成の分離 | 2 |
| P-04からP-06 | action enum、自律活動の非投稿目的、engagement非最適化 | 2、4 |
| P-07 | capability、effect ledger、別process・別Unix user | 1、4 |
| P-08 | canonical memory、provenance、forgetting、rebuildable index | 3 |
| P-09、P-10 | admin CLI、feedback candidate、versioned adaptation、rollback | 4 |
| P-11 | thinking非保存、effect追跡 | 1 |
| SR-01からSR-06 | awareness、conversation、memory、interest、mention priority | 2、3 |
| SR-07からSR-10 | audit、memory CLI、adaptation、runtime adapter | 1、3、4 |
| FR-101からFR-104 | canonical event、batch、conversation cluster | 1、2 |
| FR-201からFR-203 | addressee inferenceとconfidence | 2 |
| FR-301からFR-306 | action selection、自発投稿、internal activity | 2、4 |
| FR-401からFR-406 | utterance budget、詳細確認、不確実性、character expression | 2、4 |
| FR-501からFR-503 | autonomous activityとself memory | 4 |
| FR-601からFR-604 | short state、relationship、availability、system health | 2、3 |
| FR-701からFR-706 | feedback candidate、approval、adaptation boundary | 4 |
| DR-101からDR-104 | memory kind | 3 |
| DR-201からDR-205 | time fields、decay、ambiguity、merge、invalidate | 3 |
| DR-301からDR-304 | provenance、canonical source、rebuild、schema version | 3 |
| DR-401からDR-403 | 30日retentionとDiscord再取得 | 1、3 |
| AR-101からAR-105 | channel capability、slash command、admin boundary | 1 |
| MR-101からMR-108 | ModelRuntime、AgentRuntime、route、metrics、fallback、pi adapter | 1、5 |
| OR-101からOR-110 | latency、一次反応、audit、telemetry、CLI | 1、5 |
| 管理CLI要件 | application service経由のCLI command | 1、3、4 |
| CR-101からCR-109 | drain、stop、effect state、dedup、migration、backup | 1、5 |
| 評価要件 | deterministic test、scenario、shadow | 全Phase、5 |
| 週次振り返り要件 | weekly reportとadaptation candidate | 4 |
| AC-01からAC-11 | awareness、conversation、memory、発話、mention、error response | 1から3 |
| AC-12からAC-14 | memory audit・repair、runtime非依存state | 3 |
| AC-15 | shadow | 5 |
| NFR-01からNFR-08 | systemd、latency、cost、adapter、audit、module boundary、canonical memory、日本語専用 | 全Phase |

各Phaseの詳細設計では、このgroup mappingを個別要求ID、公開contract、仕様testへ展開する。

## 22. 固定契約と後続決定

### 22.1 本設計で固定する契約

次はPhase詳細設計で変更しない。変更する場合は本設計を改訂する。

- 3processとPostgreSQLを中心とする実行境界
- canonical event、decision run、effect ledgerを別正本とすること
- `planned -> executing -> succeeded | failed | unknown` のeffect状態
- pi sessionと検索索引を永続状態の正本にしないこと
- provenance付きcanonical memoryと30日のraw event retention
- channel capabilityと管理操作の権限分離
- shell credential分離、network egress禁止、Web tool分離
- 生のLLM thinkingを保存しないこと
- 5段階の実装依存順

### 22.2 Phase詳細設計で固定するparameter

次は本設計の境界を変えない可変parameterまたはadapter選択であり、表に示した工程で固定する。

| 決定事項 | 決定する工程 | 判断基準 |
| --- | --- | --- |
| package managerとworkspace tool | Phase 1計画 | pi package互換、Nix再現性、lockfile運用 |
| PostgreSQL DDLとmigration tool | Phase 1設計 | 明示migration、checksum、backup、型安全性 |
| event batch時間 | Phase 2設計 | 5 messages/minのburst scenario、応答latency |
| addressee algorithmと品質下限 | Phase 2設計 | 人手label corpusと誤介入cost |
| state軸と減衰係数 | 人格設計、Phase 2・3 | 人格表現、説明可能性、急変抑制 |
| relationship軸と更新量 | Phase 3設計 | 初対面、観測済み、反復interaction scenario |
| memory importanceとforgetting式 | Phase 3設計 | 昨日・半年前scenario、監視感 |
| pgvector導入 | Phase 3評価後 | PostgreSQL全文検索の失敗例と改善量 |
| 初期providerとmodel | Phase 1運用設定 | 日本語品質、latency、cost、structured output |
| Web調査tool | Phase 4設計 | source追跡、権限、cost、prompt injection耐性 |
| artifact公開方式 | Phase 4設計 | Discord file制限、retention、access control |
| Grafana Cloud接続 | Phase 5設計 | OTLP credential分離、cardinality、cost |
| 具体的人格 | 独立した人格設計 | product visionと日本語scenario |

## 23. 完了条件

本全体設計の完了条件は次のとおりである。

- 要求ベースラインの主要要求群がmodule、data、Phaseへ対応付けられている。
- pi、Discord、PostgreSQL、shellの境界が明示されている。
- memory正本と検索索引が分離されている。
- 外部作用の権限、冪等性、unknown処理が定義されている。
- 旧資産の再利用・改修・破棄・新規分類が定義されている。
- Phase 1の詳細設計へ移行できる。
## Implementation Status

- Phase 1 Task1-13: implementation complete; automated unit tests, real PostgreSQL E2E, deterministic lease-expiry/run-creation race and Gateway `system_state` singleton preflight coverage, flake, and build checks pass
- Implementation plan: `docs/superpowers/plans/2026-07-23-phase-1-durable-spine.md`
- Not verified: backup restore rehearsal, live Discord/provider credential deployment, and production CharacterDefinition go-live
- Production go-live gate: an independently reviewed production CharacterDefinition must be imported and activated before enabling Discord replies
- Deferred behavior: conversation clustering, implicit addressee inference, memory, autonomy, and adaptation remain assigned to later phases
