# memory パッケージ LLM スキーマ zod 移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/memory` の LLM 構造出力スキーマ4箇所の手書き `Schema<T>.parse()` を zod スキーマへ置換し、検証ロジックを宣言的にする。

**Architecture:** port 境界 `Schema<T>`（`{ parse(data: unknown): T }`、`llm-port.ts`）は**維持**する。zod の `ZodType.parse()` がこの interface を構造的に満たすため、各スキーマ定義を zod で書き直すだけで `chatStructured(messages, schema)` の呼び出し側・テストモックは無変更で動く。memory コアは zod に直接依存しないまま（hexagonal 維持）。**観測可能な挙動パリティ**（coercion・happy path・lenient な optional 処理）を既存 `spec/memory/*.spec.ts` で担保する。スキーマ parse のエラー文言は spec が assert していないため自由（zod デフォルトメッセージで可）。

**Tech Stack:** Bun, TypeScript, zod v4（`^4.3.6`、モノレポ標準）, oxlint/oxfmt, bun:test。検証は `nr`（`nr validate` / `nr test:spec` / `nr test:unit`）。

**スコープ外（別 Issue #1077）:** `parse-helpers.ts`（DB 行検証、`storage-rows.ts` が利用）は本 PR では触らない。

---

## 対象スキーマ（4箇所）

| ファイル                    | シンボル                                                         | 出力型                | 難度 | 主な parity 注意点                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------- | --------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critic-auditor.ts`         | `criticResultSchema`                                             | `CriticResult`        | 易   | optional フィールドは型不一致時 reject せず undefined（lenient）。keywords は非 string を filter。                                                    |
| `critic-auditor.ts`         | `guidelineResolutionSchema`                                      | `GuidelineResolution` | 易   | action enum。targetGuidelineIds は非 string を filter。                                                                                               |
| `consolidation-contract.ts` | `consolidationSchema`                                            | `ConsolidationOutput` | 中   | keywords は string(カンマ区切り)→array に coerce。action による discriminated union（reinforce/update/invalidate は existingFactId 必須）。各種上限。 |
| `segmenter.ts`              | `createSegmentationSchema()` が返す `Schema<SegmentationOutput>` | `SegmentationOutput`  | 難   | runtime 引数 `messageCount` 依存の境界。`validateSegmentSequence` による cross-field 検証。                                                           |

**重要な parity 原則:** zod スキーマの `.parse()` 出力は、現行手書き `parse()` の出力と**同一**でなければならない（`toEqual` レベル）。特に:

- 現行が「型不一致の optional を undefined にして**キーを残す**」(`field: cond ? x : undefined`) のに対し、zod の `.optional()` は欠損キーを省く。`toEqual` はこの差を検出しうるため、テストが落ちたら zod 側を `.transform` で現行の出力形に合わせる（または現行 .test.ts の期待を観測挙動に合わせて更新する。`*.test.ts` は実装詳細なので更新可、`*.spec.ts` は契約なので不可）。
- lenient フィルタ（非 string 要素を捨てる）は `z.array(z.unknown()).transform(a => a.filter(v => typeof v === "string"))` 等で再現。

---

## Task 0: ブランチ作成 + zod 依存追加

**Files:**

- Modify: `packages/memory/package.json`

- [ ] **Step 1: 作業ブランチを切る**

```bash
git switch -c refactor/memory-zod-migration
```

- [ ] **Step 2: zod を dependencies に追加**

`packages/memory/package.json` の `dependencies` に zod を追加（shared/agent と同じ range）:

```json
	"dependencies": {
		"@vicissitude/shared": "workspace:*",
		"zod": "^4.3.6"
	}
```

- [ ] **Step 3: インストールして単一バージョン解決を確認**

Run: `bun install`
Expected: 成功。`bun pm ls 2>/dev/null | grep zod` で memory が既存と同じ zod に解決されること（新規メジャー差分が出ないこと）を確認。

- [ ] **Step 4: ベースライン確認（移行前に全 green を確認）**

Run: `nr test:spec -- spec/memory/critic-auditor.spec.ts spec/memory/consolidation.spec.ts`
Expected: PASS（移行のリグレッション基準）

- [ ] **Step 5: commit**

```bash
git add packages/memory/package.json bun.lock
git commit -m "build(memory): zod を依存に追加する"
```

---

## Task 1: critic-auditor の2スキーマを zod 化

**Files:**

- Modify: `packages/memory/src/critic-auditor.ts`
- Test (guard): `spec/memory/critic-auditor.spec.ts`, `packages/memory/src/critic-auditor.test.ts`

現行（参考、`critic-auditor.ts` 末尾付近）:

- `criticResultSchema.parse` は severity(enum none/minor/major) と summary(非空) を必須検証し、`guidelineFact`/`guidelineKeywords`/`issueTitle`/`issueBody` を lenient に取り込む（型不一致は undefined / keywords は非 string を filter）。`driftScore`・`guidelineResolution` は LLM 出力からは parse しない（後段ロジックが付与）。
- `guidelineResolutionSchema.parse` は action(enum save/discard/replace) と reason(非空) 必須、`targetGuidelineIds` を lenient 取り込み（非 string filter）。

- [ ] **Step 1: zod import を追加**

`critic-auditor.ts` 冒頭の import 群に追加:

```ts
import { z } from "zod";
```

- [ ] **Step 2: `criticResultSchema` を zod へ置換**

`const criticResultSchema: Schema<CriticResult> = { parse(...) {...} }` を以下へ置換（`Schema<CriticResult>` 型注釈は維持 — zod スキーマが構造的に満たす）:

```ts
const criticResultSchema: Schema<CriticResult> = z.object({
	severity: z.enum(["none", "minor", "major"]),
	summary: z.string().min(1),
	guidelineFact: z.string().optional().catch(undefined),
	guidelineKeywords: z
		.array(z.unknown())
		.transform((arr) => arr.filter((v): v is string => typeof v === "string"))
		.optional()
		.catch(undefined),
	issueTitle: z.string().optional().catch(undefined),
	issueBody: z.string().optional().catch(undefined),
});
```

> 注: `Schema<T>` は `parse(data: unknown): T` のみを要求し、zod の `ZodType` は `.parse` を持つため代入可。`z.infer` 型が `CriticResult` の parse 対象サブセットと一致しない場合（例: optional キーの有無）は、`Schema<CriticResult>` 注釈で受けつつ、テストで出力形を確認して `.transform` で調整する。

- [ ] **Step 3: `guidelineResolutionSchema` を zod へ置換**

```ts
const guidelineResolutionSchema: Schema<GuidelineResolution> = z.object({
	action: z.enum(["save", "discard", "replace"]),
	reason: z.string().min(1),
	targetGuidelineIds: z
		.array(z.unknown())
		.transform((arr) => arr.filter((v): v is string => typeof v === "string"))
		.optional()
		.catch(undefined),
});
```

- [ ] **Step 4: 不要になったローカル定数・ヘルパを削除**

`VALID_SEVERITIES` / `VALID_GUIDELINE_RESOLUTION_ACTIONS` 等、置換した parse 専用の Set 定数が他で未使用になったら削除（`nr lint` の no-unused-vars で検出）。`Schema` 型 import は引き続き使うので残す。

- [ ] **Step 5: 型チェック**

Run: `nr check`
Expected: PASS（落ちたら `Schema<T>` 代入互換性・optional 出力形を調整）

- [ ] **Step 6: ガードテスト実行**

Run: `nr test:spec -- spec/memory/critic-auditor.spec.ts` then `nr test:unit -- packages/memory/src/critic-auditor.test.ts`
Expected: 両方 PASS。`critic-auditor.test.ts` がスキーマ parse の**エラー文言**や **optional キーの有無**を白箱で assert していて落ちる場合は、観測挙動（zod の出力）に合わせてその `*.test.ts` の期待値を更新する（`*.test.ts` は実装詳細なので可）。`*.spec.ts` が落ちる場合は zod スキーマ側を修正する（契約は不変）。

- [ ] **Step 7: lint & commit**

```bash
nr fmt
git add packages/memory/src/critic-auditor.ts packages/memory/src/critic-auditor.test.ts
git commit -m "refactor(memory): critic-auditor の構造出力スキーマを zod 化する"
```

---

## Task 2: consolidationSchema を zod 化

**Files:**

- Modify: `packages/memory/src/consolidation-contract.ts`
- Test (guard): `spec/memory/consolidation.spec.ts`, `packages/memory/src/consolidation.test.ts`

現行 parity 要件（`consolidation-contract.ts`）:

- `facts` は配列必須、要素数上限 `MAX_FACTS_PER_EPISODE = 30`。
- 各 fact: `action`(enum: CONSOLIDATION_ACTIONS), `category`(enum: FACT_CATEGORIES), `fact`(非空・`MAX_FACT_LENGTH = 1000` 以下)。
- `keywords`: **string ならカンマ区切りを split→trim→空除去で配列化**、array ならそのまま。要素数上限 `MAX_KEYWORDS_PER_FACT = 10`、各要素 string・`MAX_KEYWORD_LENGTH = 100` 以下。
- `existingFactId`: action が reinforce/update/invalidate のとき string 必須、new のとき不要。出力は `toExtractedFact` で discriminated union 形（new は existingFactId 無し、その他は existingFactId 有り）。

- [ ] **Step 1: zod import を追加**

```ts
import { z } from "zod";
```

- [ ] **Step 2: keywords の coerce を行う共通 zod 部品を定義**

```ts
const keywordsSchema = z
	.union([
		z.string().transform((s) =>
			s
				.split(",")
				.map((k) => k.trim())
				.filter((k) => k !== ""),
		),
		z.array(z.string().max(MAX_KEYWORD_LENGTH)),
	])
	.pipe(z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_KEYWORDS_PER_FACT));
```

> `MAX_KEYWORD_LENGTH` / `MAX_KEYWORDS_PER_FACT` / `MAX_FACT_LENGTH` / `MAX_FACTS_PER_EPISODE` の既存定数はそのまま再利用する。

- [ ] **Step 3: action 別の discriminated union で fact スキーマを定義**

```ts
const baseFactFields = {
	category: z.enum(FACT_CATEGORIES),
	fact: z.string().min(1).max(MAX_FACT_LENGTH),
	keywords: keywordsSchema,
};

const extractedFactSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("new"), ...baseFactFields }),
	z.object({ action: z.literal("reinforce"), existingFactId: z.string(), ...baseFactFields }),
	z.object({ action: z.literal("update"), existingFactId: z.string(), ...baseFactFields }),
	z.object({ action: z.literal("invalidate"), existingFactId: z.string(), ...baseFactFields }),
]);
```

> `FACT_CATEGORIES` / `CONSOLIDATION_ACTIONS` は `./types.ts` の as-const 配列。`z.enum(FACT_CATEGORIES)` が型エラーになる場合は `z.enum(FACT_CATEGORIES as [string, ...string[]])` ではなく、`types.ts` の配列が `readonly [...]` なら `z.enum` がそのまま受ける（zod v4）。受けない場合は `z.enum([...FACT_CATEGORIES])`。

- [ ] **Step 4: `consolidationSchema` を置換**

```ts
export const consolidationSchema: Schema<ConsolidationOutput> = z.object({
	facts: z.array(extractedFactSchema).max(MAX_FACTS_PER_EPISODE),
});
```

`validateExtractedFact` / `validateFactFields` / `validateKeywords` / `validateExistingFactId` / `toExtractedFact` / `RawExtractedFact` / `VALID_ACTIONS` / `VALID_CATEGORIES` / `ACTIONS_REQUIRING_EXISTING_FACT_ID` のうち、zod 置換で未使用になったものを削除（`nr lint` で検出）。`ExtractedFact` 等の**型** export は他モジュールが使うため残す。

> discriminated union の出力が `ExtractedFact`（new に existingFactId が無い形）と一致することを `z.infer` と既存型で確認。`ConsolidationOutput`/`ExtractedFact` 型注釈・代入が通ること。

- [ ] **Step 5: 型チェック** — Run: `nr check` / Expected: PASS

- [ ] **Step 6: ガードテスト**

Run: `nr test:spec -- spec/memory/consolidation.spec.ts` then `nr test:unit -- packages/memory/src/consolidation.test.ts`
Expected: PASS。特に keywords の string→array coerce、existingFactId 必須/不要、上限超過の reject を確認。`*.test.ts` がエラー文言を assert して落ちたら観測挙動に合わせ更新（`*.spec.ts` は不変）。

- [ ] **Step 7: lint & commit**

```bash
nr fmt
git add packages/memory/src/consolidation-contract.ts packages/memory/src/consolidation.test.ts
git commit -m "refactor(memory): consolidation の抽出スキーマを zod 化する"
```

---

## Task 3: segmenter スキーマを zod 化

**Files:**

- Modify: `packages/memory/src/segmenter.ts`
- Test (guard): `spec/memory/` の segmenter 関連 spec（`grep -rl segment spec/memory`)・`packages/memory/src/segmenter` 関連 test（存在すれば）

現行 parity 要件（`segmenter.ts` の `createSegmentationSchema(messageCount, options)`）:

- `segments` 配列必須。各 segment は `parseSegment(s, i, messageCount)` で検証:
  - `startIndex`/`endIndex`: 非負整数、endIndex > startIndex、endIndex <= messageCount。
  - `title`(string・`MAX_TITLE_LENGTH = 200` 以下)、`summary`(string・`MAX_SUMMARY_LENGTH = 2000` 以下)。
  - surprise レベル（`VALID_SURPRISE = low/high/extremely_high`）等、`validateSegmentFields` の必須フィールド。
- パース後に `validateSegmentSequence(segments, options)` で**シーケンス検証**（順序・連続性・minMessages 等）。

**方針:** 構造検証を zod 化し、runtime 依存（messageCount）と cross-field 検証は zod の `.superRefine` で既存ヘルパを呼び出して温存する（最小リスク）。

- [ ] **Step 1: zod import を追加**

```ts
import { z } from "zod";
```

- [ ] **Step 2: 単一 segment の構造スキーマを定義（messageCount 依存部は superRefine）**

`parseSegment` 内の構造検証（`validateSegmentFields` / `validateIndexBounds` 相当）を zod の object スキーマへ移す。messageCount 依存の `endIndex <= messageCount` と整数性は object レベルの `.superRefine` で表現:

```ts
function segmentSchema(messageCount: number) {
	return z
		.object({
			startIndex: z.number().int().nonnegative(),
			endIndex: z.number().int(),
			title: z.string().max(MAX_TITLE_LENGTH),
			summary: z.string().max(MAX_SUMMARY_LENGTH),
			surprise: z.enum(["low", "high", "extremely_high"]),
			// 既存 parseSegment が受け取る他フィールドがあればここに追加（startMessageId 等、現行実装に合わせる）
		})
		.superRefine((seg, ctx) => {
			if (seg.endIndex <= seg.startIndex) {
				ctx.addIssue({ code: "custom", message: "endIndex must be greater than startIndex" });
			}
			if (seg.endIndex > messageCount) {
				ctx.addIssue({ code: "custom", message: `endIndex exceeds message count ${messageCount}` });
			}
		});
}
```

> **重要:** `parseSegment` の現行フィールド集合を必ず確認し、過不足なく移植する（surprise の扱い・任意フィールド・型変換を含む）。出力型 `SegmentResult` と一致させる。

- [ ] **Step 3: `createSegmentationSchema` を zod ベースに置換（sequence 検証は温存）**

```ts
function createSegmentationSchema(
	messageCount: number,
	options: SegmentationValidationOptions,
): Schema<SegmentationOutput> {
	return z.object({ segments: z.array(segmentSchema(messageCount)) }).superRefine((output, ctx) => {
		try {
			validateSegmentSequence(output.segments, options);
		} catch (err) {
			ctx.addIssue({
				code: "custom",
				message: err instanceof Error ? err.message : "invalid segment sequence",
			});
		}
	});
}
```

> `validateSegmentSequence` は**そのまま温存**（cross-field のドメイン検証）。`parseSegment` / `validateSegmentFields` / `validateIndexBounds` は zod へ移したら未使用分を削除（`validateSegmentSequence` が内部で使う部分は残す）。`VALID_SURPRISE` / `MAX_TITLE_LENGTH` / `MAX_SUMMARY_LENGTH` の使用状況を lint で確認。

- [ ] **Step 4: 型チェック** — Run: `nr check` / Expected: PASS（`SegmentationOutput` 代入互換・`z.infer` と `SegmentResult` 整合）

- [ ] **Step 5: ガードテスト**

まず segmenter のテスト所在を特定:
Run: `grep -rl "createSegmentationSchema\|SegmentationOutput\|segment" spec/memory packages/memory/src --include='*.spec.ts' --include='*.test.ts'`
次に該当を実行（例）:
Run: `nr test:spec -- spec/memory/segmenter.spec.ts` / `nr test:unit -- packages/memory/src/segmenter.test.ts`（存在するものだけ）
Expected: PASS。境界（endIndex 超過・非整数・sequence 不正）の reject と happy path を確認。エラー文言依存の `*.test.ts` は観測挙動へ更新可。

- [ ] **Step 6: lint & commit**

```bash
nr fmt
git add packages/memory/src/segmenter.ts
git commit -m "refactor(memory): segmenter の構造出力スキーマを zod 化する"
```

---

## Task 4: 全体検証 + PR

- [ ] **Step 1: fmt**

Run: `nr fmt`

- [ ] **Step 2: validate（fmt:check + lint + check）**

Run: `nr validate`
Expected: 全 PASS（0 errors）。未使用になった旧検証ヘルパ・定数が残っていれば削除。

- [ ] **Step 3: 全テスト**

Run: `nr test`
Expected: 全 PASS。memory 関連 spec/unit が新 zod スキーマで green。

- [ ] **Step 4: zod 単一解決の最終確認**

Run: `bun pm ls 2>/dev/null | grep -c zod` 等で zod のバージョン分裂が増えていないことを確認。問題があれば Issue #1051（root `overrides`）の対応を別途検討（本 PR では深追いしない）。

- [ ] **Step 5: push & PR**

```bash
git push -u origin refactor/memory-zod-migration
gh pr create --fill
```

PR 本文に「スコープ外: parse-helpers.ts は Issue #1077」を明記する。

---

## Self-Review

**1. Spec coverage:** 対象4スキーマ（critic x2=Task1, consolidation=Task2, segmenter=Task3）すべてにタスクあり。各タスクの guard は対応する `spec/memory/*.spec.ts`（契約）。port 境界 `Schema<T>` 維持により `chatStructured` 呼び出し側・テストモックは無変更。

**2. Placeholder scan:** 各 zod スキーマの具体コードを記載。segmenter のみ「現行 `parseSegment` のフィールド集合を確認して移植」という確認指示があるが、これは TBD ではなく「現行実装の field を過不足なく写経する」明示指示（`nr check`/spec が過不足を検出）。

**3. Type consistency:** `Schema<T>` 型注釈は全タスクで維持（`criticResultSchema: Schema<CriticResult>` 等）。定数名（`MAX_FACT_LENGTH` 等）は既存を再利用。zod は `z`（`import { z } from "zod"`）で統一。

**4. リスク:** memory 内部スキーマのみで spec はモック経由のため Issue #1051 のクロス版数問題には当たらない。最大リスクは parity（特に optional キーの有無・segmenter の cross-field）だが、`*.spec.ts` ガード + `*.test.ts` 更新可で吸収。store スキーマ・live DB への影響なし。
