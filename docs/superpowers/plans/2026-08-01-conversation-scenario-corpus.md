# Conversation Scenario Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 設計 §6 の scenario corpus（会話シナリオ + 人手ラベル、初期10ケース）を `spec/corpus/conversations/` に整備し、スキーマ検証で全ファイルの整合性を CI で保証する。

**Architecture:** 1 ファイル = 1 scenario の JSON を zod スキーマで検証する。スキーマとローダーは `spec/corpus/scenario.ts` に置き、`spec/corpus/corpus.spec.ts` が全 JSON のパースと横断不変条件（イベント順序、ID 参照整合、ラベル整合）を検証する。評価は当面人手のみで、LLM 品質の数値化や `spec/e2e/` ハーネス接続は行わない（設計 §6）。

**Tech Stack:** TypeScript (NodeNext / strict), zod 4, vitest。テストは `spec/**/*.spec.ts` として既存の spec スイートに乗る（DB は使わない）。

**参照設計:** `docs/superpowers/specs/2026-07-29-phase-2-conversation-cognition-design.md` §6

---

## File Structure

- `spec/corpus/scenario.ts` — scenario の zod スキーマ（型 + 不変条件）とディレクトリローダー。テスト対象コード
- `spec/corpus/corpus.spec.ts` — スキーマ単体の受理/拒否テストと、corpus 全ファイルの検証
- `spec/corpus/conversations/NN-<name>.json` — scenario 本体（初期10ファイル）
- `spec/corpus/README.md` — ラベルの意味と人手評価の使い方

ラベルの意味論（スキーマの doc コメントと README に記載する）:

- `addressee` — 評価対象となるトリガーメッセージの宛先（キャラクター / 特定ユーザー / チャンネル全体 / 不明）。明示的な宛先を持たない後続メッセージは直前のトリガーを引き継ぐ
- `expectedAction` — シナリオ終端でキャラクターに期待する行動（`reply` / `silence` / `defer`）
- `referencedMessageIds` — 正しい応答が踏まえているべきメッセージの ID 集合（silence なら空）
- `maxWaitMs` — トリガーから応答までの許容最大待機時間。`silence` シナリオでは `null`
- `misinterventionSeverity` — このシナリオで誤介入（不要な発言・誤った会話への参加）をした場合の重大度

---

### Task 1: 作業ブランチと scenario スキーマ

**Files:**
- Create: `spec/corpus/scenario.ts`
- Create: `spec/corpus/corpus.spec.ts`

- [ ] **Step 1: 作業ブランチを切り、この計画をコミットする**

```bash
git switch -c feat/conversation-scenario-corpus
git add docs/superpowers/plans/2026-08-01-conversation-scenario-corpus.md
git commit -m "docs: add conversation scenario corpus implementation plan"
```

- [ ] **Step 2: スキーマの失敗するテストを書く**

`spec/corpus/corpus.spec.ts` を次の内容で作成する。

```ts
import { describe, expect, it } from "vitest";
import { conversationScenarioSchema } from "./scenario.js";

const message1 = {
  kind: "message",
  atMs: 0,
  id: "m1",
  channelId: "channel-1",
  threadId: null,
  actorId: "user-a",
  content: "@ふあ こんにちは",
  mentionsBot: true,
};

const baseLabel = {
  addressee: { kind: "character" },
  expectedAction: "reply",
  referencedMessageIds: ["m1"],
  maxWaitMs: 15000,
  misinterventionSeverity: "low",
};

const base = {
  name: "fixture",
  description: "スキーマ検証用のフィクスチャ",
  guildId: "guild-1",
  events: [message1],
  label: baseLabel,
};

describe("conversationScenarioSchema", () => {
  it("accepts a valid scenario and fills defaults", () => {
    const result = conversationScenarioSchema.parse(base);
    expect(result.events[0]).toMatchObject({ kind: "message", replyToId: null });
  });

  it("accepts a silence scenario without maxWaitMs", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [{ ...message1, content: "腹減った", mentionsBot: false }],
      label: {
        addressee: { kind: "channel" },
        expectedAction: "silence",
        referencedMessageIds: [],
        maxWaitMs: null,
        misinterventionSeverity: "medium",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects events that are not ordered by atMs", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [{ ...message1, atMs: 5000 }, { ...message1, id: "m2", atMs: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate message ids", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [message1, { ...message1, atMs: 1000 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a replyToId that references an unknown or later message", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      events: [{ ...message1, replyToId: "m9" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects referencedMessageIds pointing to an unknown message", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      label: { ...baseLabel, referencedMessageIds: ["m9"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a reply scenario without maxWaitMs", () => {
    const result = conversationScenarioSchema.safeParse({
      ...base,
      label: { ...baseLabel, maxWaitMs: null },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `pnpm exec vitest run spec/corpus/corpus.spec.ts`
Expected: FAIL（`./scenario.js` が見つからない）

- [ ] **Step 4: スキーマを実装する**

`spec/corpus/scenario.ts` を次の内容で作成する。

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const messageEventSchema = z.object({
  kind: z.literal("message"),
  atMs: z.number().int().nonnegative(),
  id: z.string().min(1),
  channelId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  actorId: z.string().min(1),
  content: z.string().min(1),
  mentionsBot: z.boolean().default(false),
  replyToId: z.string().min(1).nullable().default(null),
});

const typingEventSchema = z.object({
  kind: z.literal("typing"),
  atMs: z.number().int().nonnegative(),
  channelId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  actorId: z.string().min(1),
});

const scenarioEventSchema = z.discriminatedUnion("kind", [messageEventSchema, typingEventSchema]);

/** 評価対象となるトリガーメッセージの宛先。明示的な宛先を持たない後続メッセージは直前のトリガーを引き継ぐ。 */
const addresseeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("character") }),
  z.object({ kind: z.literal("user"), actorId: z.string().min(1) }),
  z.object({ kind: z.literal("channel") }),
  z.object({ kind: z.literal("unknown") }),
]);

const labelSchema = z.object({
  addressee: addresseeSchema,
  expectedAction: z.enum(["reply", "silence", "defer"]),
  /** 正しい応答が踏まえているべきメッセージの ID。silence なら空。 */
  referencedMessageIds: z.array(z.string().min(1)),
  /** トリガーから応答までの許容最大待機時間。silence シナリオでは null。 */
  maxWaitMs: z.number().int().positive().nullable(),
  /** このシナリオで誤介入した場合の重大度。 */
  misinterventionSeverity: z.enum(["low", "medium", "high"]),
  notes: z.string().optional(),
});

export const conversationScenarioSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    guildId: z.string().min(1),
    events: z.array(scenarioEventSchema).min(1),
    label: labelSchema,
  })
  .superRefine((scenario, ctx) => {
    const messageIds = new Set<string>();
    let lastAtMs = -1;
    for (const [index, event] of scenario.events.entries()) {
      if (event.atMs < lastAtMs) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "atMs"],
          message: "events must be ordered by atMs",
        });
      }
      lastAtMs = event.atMs;
      if (event.kind !== "message") continue;
      if (messageIds.has(event.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: `duplicate message id: ${event.id}`,
        });
      }
      if (event.replyToId !== null && !messageIds.has(event.replyToId)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", index, "replyToId"],
          message: `replyToId must reference an earlier message: ${event.replyToId}`,
        });
      }
      messageIds.add(event.id);
    }
    for (const id of scenario.label.referencedMessageIds) {
      if (!messageIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["label", "referencedMessageIds"],
          message: `referencedMessageIds references an unknown message: ${id}`,
        });
      }
    }
    if (scenario.label.expectedAction === "reply" && scenario.label.maxWaitMs === null) {
      ctx.addIssue({
        code: "custom",
        path: ["label", "maxWaitMs"],
        message: "reply scenarios must define maxWaitMs",
      });
    }
  });

export type ConversationScenario = z.infer<typeof conversationScenarioSchema>;

export interface LoadedScenario {
  file: string;
  scenario: ConversationScenario;
}

export function loadScenarios(dir: string): LoadedScenario[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const parsed = conversationScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.message}`);
    }
    return { file, scenario: parsed.data };
  });
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm exec vitest run spec/corpus/corpus.spec.ts`
Expected: PASS（7 tests）

- [ ] **Step 6: コミット**

```bash
git add spec/corpus/scenario.ts spec/corpus/corpus.spec.ts
git commit -m "feat: add conversation scenario schema and loader"
```

---

### Task 2: corpus ローダー検証と最初の scenario

**Files:**
- Create: `spec/corpus/conversations/01-explicit-mention.json`
- Modify: `spec/corpus/corpus.spec.ts`（describe ブロックを追加）

- [ ] **Step 1: corpus 全体を検証する失敗するテストを追加する**

`spec/corpus/corpus.spec.ts` の import に `loadScenarios` と `node:path` を追加し、ファイル末尾に describe ブロックを追加する。

```ts
// import 部に追加
import { join } from "node:path";
import { conversationScenarioSchema, loadScenarios } from "./scenario.js";
```

```ts
// ファイル末尾に追加
const conversationsDir = join(import.meta.dirname, "conversations");

describe("conversation corpus", () => {
  it("loads every scenario file with a unique name", () => {
    const scenarios = loadScenarios(conversationsDir);
    expect(scenarios.length).toBeGreaterThanOrEqual(1);
    const names = scenarios.map((entry) => entry.scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run spec/corpus/corpus.spec.ts`
Expected: FAIL（`conversations` ディレクトリが存在しない）

- [ ] **Step 3: 最初の scenario を作成する**

`spec/corpus/conversations/01-explicit-mention.json`:

```json
{
  "name": "explicit-mention",
  "description": "キャラクターへの明示 mention。単純な1件のメッセージに reply する。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "@ふあ 今日のごはん何がいいと思う？",
      "mentionsBot": true
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m1"],
    "maxWaitMs": 15000,
    "misinterventionSeverity": "low"
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm exec vitest run spec/corpus/corpus.spec.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: コミット**

```bash
git add spec/corpus/corpus.spec.ts spec/corpus/conversations/01-explicit-mention.json
git commit -m "feat: validate conversation corpus files and add first scenario"
```

---

### Task 3: scenario 02〜05

**Files:**
- Create: `spec/corpus/conversations/02-name-in-reply-to-other.json`
- Create: `spec/corpus/conversations/03-name-call-question.json`
- Create: `spec/corpus/conversations/04-mention-during-burst.json`
- Create: `spec/corpus/conversations/05-typing-extension.json`

- [ ] **Step 1: scenario 02（他人への reply 内に名前 → silence）を作成する**

`spec/corpus/conversations/02-name-in-reply-to-other.json`:

```json
{
  "name": "name-in-reply-to-other",
  "description": "他人への reply の中にキャラクターの名前が出るだけ。宛先はキャラクターではないので silence。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "昨日ふあが変なこと言っててさ、笑った"
    },
    {
      "kind": "message",
      "atMs": 8000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-b",
      "content": "それな、ふあらしいよね",
      "replyToId": "m1"
    }
  ],
  "label": {
    "addressee": { "kind": "user", "actorId": "user-a" },
    "expectedAction": "silence",
    "referencedMessageIds": [],
    "maxWaitMs": null,
    "misinterventionSeverity": "medium",
    "notes": "名前が出ているだけで会話には誘われていない。割り込むと自意識過剰に見える。"
  }
}
```

- [ ] **Step 2: scenario 03（名前呼び質問 → reply）を作成する**

`spec/corpus/conversations/03-name-call-question.json`:

```json
{
  "name": "name-call-question",
  "description": "mention なしの名前呼び質問「ふあはどう思う？」。宛先はキャラクターなので reply。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "新しいゲーム、正直微妙だった"
    },
    {
      "kind": "message",
      "atMs": 12000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-b",
      "content": "えー、俺は好きだけどな"
    },
    {
      "kind": "message",
      "atMs": 20000,
      "id": "m3",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "ふあはどう思う？"
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m1", "m2", "m3"],
    "maxWaitMs": 20000,
    "misinterventionSeverity": "low"
  }
}
```

- [ ] **Step 3: scenario 04（連投中の mention → batch 後に reply）を作成する**

`spec/corpus/conversations/04-mention-during-burst.json`:

```json
{
  "name": "mention-during-burst",
  "description": "複数人の連投中に明示 mention。batch で連投をまとめてから reply する。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "今夜のイベント何時からだっけ"
    },
    {
      "kind": "message",
      "atMs": 3000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-b",
      "content": "21時じゃなかった？"
    },
    {
      "kind": "message",
      "atMs": 6000,
      "id": "m3",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-c",
      "content": "@ふあ も来るの？",
      "mentionsBot": true
    },
    {
      "kind": "message",
      "atMs": 9000,
      "id": "m4",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "21時か、ギリギリだな"
    },
    {
      "kind": "message",
      "atMs": 12000,
      "id": "m5",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-b",
      "content": "遅れてもいいらしいよ"
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m1", "m2", "m3", "m4", "m5"],
    "maxWaitMs": 30000,
    "misinterventionSeverity": "low",
    "notes": "mention 直後に即答するより、連投が落ち着いてから答える方が自然。"
  }
}
```

- [ ] **Step 4: scenario 05（typing 中の追加メッセージ → 同じ batch）を作成する**

`spec/corpus/conversations/05-typing-extension.json`:

```json
{
  "name": "typing-extension",
  "description": "mention の後に typing が始まり、追加メッセージが来る。追加分を同じ batch に含めて reply する。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "@ふあ ちょっと聞きたいんだけど",
      "mentionsBot": true
    },
    {
      "kind": "typing",
      "atMs": 4000,
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a"
    },
    {
      "kind": "message",
      "atMs": 9000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "この前話してた漫画のタイトルって何だっけ"
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m1", "m2"],
    "maxWaitMs": 30000,
    "misinterventionSeverity": "low",
    "notes": "m1 だけを見て「どうしたの？」と返すのは早すぎる。m2 まで待って答える。"
  }
}
```

- [ ] **Step 5: 全 corpus が検証を通ることを確認する**

Run: `pnpm exec vitest run spec/corpus/corpus.spec.ts`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add spec/corpus/conversations
git commit -m "feat: add burst, typing, and addressing scenarios to corpus"
```

---

### Task 4: scenario 06〜10 と最小件数の保証

**Files:**
- Create: `spec/corpus/conversations/06-thread-conversation.json`
- Create: `spec/corpus/conversations/07-parallel-conversations.json`
- Create: `spec/corpus/conversations/08-split-question.json`
- Create: `spec/corpus/conversations/09-needs-clarification.json`
- Create: `spec/corpus/conversations/10-unrelated-chatter.json`
- Modify: `spec/corpus/corpus.spec.ts`

- [ ] **Step 1: 最小10件を要求する失敗するテストに更新する**

`spec/corpus/corpus.spec.ts` の `loads every scenario file with a unique name` 内のアサーションを変更する。

```ts
expect(scenarios.length).toBeGreaterThanOrEqual(10);
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `pnpm exec vitest run spec/corpus/corpus.spec.ts`
Expected: FAIL（5 scenarios しかない）

- [ ] **Step 3: scenario 06（thread 内の会話 → thread が scope 境界）を作成する**

`spec/corpus/conversations/06-thread-conversation.json`:

```json
{
  "name": "thread-conversation",
  "description": "thread 内の会話。thread が scope 境界であり、親チャンネルの会話と混ぜない。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "今日の配信面白かった"
    },
    {
      "kind": "message",
      "atMs": 5000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": "thread-build",
      "actorId": "user-b",
      "content": "拠点の設計図できたから貼っておく"
    },
    {
      "kind": "message",
      "atMs": 12000,
      "id": "m3",
      "channelId": "channel-general",
      "threadId": "thread-build",
      "actorId": "user-c",
      "content": "@ふあ この設計どう思う？",
      "mentionsBot": true
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m2", "m3"],
    "maxWaitMs": 20000,
    "misinterventionSeverity": "medium",
    "notes": "親チャンネルの m1 は別会話。thread 内の文脈だけで答える。"
  }
}
```

- [ ] **Step 4: scenario 07（並行会話 → 誤った会話へ介入しない）を作成する**

`spec/corpus/conversations/07-parallel-conversations.json`:

```json
{
  "name": "parallel-conversations",
  "description": "同じ channel で2つの会話が並行する。宛先の会話だけを見て reply し、もう一方へ介入しない。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "レポート終わらん、助けて"
    },
    {
      "kind": "message",
      "atMs": 4000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-b",
      "content": "昨日のサッカー見た？"
    },
    {
      "kind": "message",
      "atMs": 8000,
      "id": "m3",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-c",
      "content": "見た見た、最後のゴールやばかった",
      "replyToId": "m2"
    },
    {
      "kind": "message",
      "atMs": 12000,
      "id": "m4",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "@ふあ 気分転換になる話して",
      "mentionsBot": true
    },
    {
      "kind": "message",
      "atMs": 15000,
      "id": "m5",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-b",
      "content": "延長までもつれると思わなかったわ",
      "replyToId": "m3"
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m1", "m4"],
    "maxWaitMs": 25000,
    "misinterventionSeverity": "high",
    "notes": "サッカーの会話 (m2, m3, m5) は別クラスタ。そちらの話題を混ぜて返すのは誤介入。"
  }
}
```

- [ ] **Step 5: scenario 08(分割投稿の質問 → 最後まで待って reply)を作成する**

`spec/corpus/conversations/08-split-question.json`:

```json
{
  "name": "split-question",
  "description": "質問が複数メッセージに分割して投稿される。最後まで待ってから reply する。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "@ふあ 相談があるんだけど",
      "mentionsBot": true
    },
    {
      "kind": "message",
      "atMs": 6000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "来週の集まりの店を決めたくて"
    },
    {
      "kind": "message",
      "atMs": 14000,
      "id": "m3",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "和食と中華どっちがいいと思う？"
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m1", "m2", "m3"],
    "maxWaitMs": 40000,
    "misinterventionSeverity": "low",
    "notes": "m1 の時点で反応すると質問の本体を取りこぼす。m3 まで待つ。"
  }
}
```

- [ ] **Step 6: scenario 09（追加情報が必要 → 詳細確認の reply）を作成する**

`spec/corpus/conversations/09-needs-clarification.json`:

```json
{
  "name": "needs-clarification",
  "description": "回答に追加情報が必要な依頼。すぐ成果物を出さず、詳細確認の reply を返す。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "@ふあ 例のやつ調べてまとめといて",
      "mentionsBot": true
    }
  ],
  "label": {
    "addressee": { "kind": "character" },
    "expectedAction": "reply",
    "referencedMessageIds": ["m1"],
    "maxWaitMs": 15000,
    "misinterventionSeverity": "low",
    "notes": "「例のやつ」が特定できない前提のシナリオ。知ったかぶりで長文をまとめるのではなく、何を指すか確認する短い reply が正解。"
  }
}
```

- [ ] **Step 7: scenario 10（無関係な雑談 → silence）を作成する**

`spec/corpus/conversations/10-unrelated-chatter.json`:

```json
{
  "name": "unrelated-chatter",
  "description": "キャラクターに向けられていない雑談。観察するだけで silence。",
  "guildId": "guild-1",
  "events": [
    {
      "kind": "message",
      "atMs": 0,
      "id": "m1",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "腹減った"
    },
    {
      "kind": "message",
      "atMs": 7000,
      "id": "m2",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-b",
      "content": "ラーメン行く？"
    },
    {
      "kind": "message",
      "atMs": 11000,
      "id": "m3",
      "channelId": "channel-general",
      "threadId": null,
      "actorId": "user-a",
      "content": "いいね、いつもの店で",
      "replyToId": "m2"
    }
  ],
  "label": {
    "addressee": { "kind": "user", "actorId": "user-b" },
    "expectedAction": "silence",
    "referencedMessageIds": [],
    "maxWaitMs": null,
    "misinterventionSeverity": "medium",
    "notes": "ユーザー同士で完結している雑談。毎回割り込むと煩わしいボットになる。"
  }
}
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `pnpm exec vitest run spec/corpus/corpus.spec.ts`
Expected: PASS（10 scenarios を読み込み、全件スキーマ検証を通過）

- [ ] **Step 9: コミット**

```bash
git add spec/corpus
git commit -m "feat: complete the initial ten-scenario conversation corpus"
```

---

### Task 5: README・全体検証・PR

**Files:**
- Create: `spec/corpus/README.md`

- [ ] **Step 1: 人手評価向け README を作成する**

`spec/corpus/README.md`:

```markdown
# Conversation Scenario Corpus

Phase 2 の batch パラメータと宛先推定品質を人手評価するための会話シナリオ集。
設計: `docs/superpowers/specs/2026-07-29-phase-2-conversation-cognition-design.md` §6

## 形式

- `conversations/NN-<name>.json` が 1 ファイル = 1 scenario
- スキーマは `scenario.ts` の `conversationScenarioSchema`。`corpus.spec.ts` が全ファイルを検証する

## ラベルの意味

- `addressee` — 評価対象となるトリガーメッセージの宛先。明示的な宛先を持たない後続メッセージは直前のトリガーを引き継ぐ
- `expectedAction` — シナリオ終端でキャラクターに期待する行動（`reply` / `silence` / `defer`）
- `referencedMessageIds` — 正しい応答が踏まえているべきメッセージの ID（silence なら空）
- `maxWaitMs` — トリガーから応答までの許容最大待機時間。`batchWindow` / `maxWait` の設定値はこのラベルを根拠に決める。silence では `null`
- `misinterventionSeverity` — このシナリオで誤介入した場合の重大度
- `notes` — 評価者向けの補足。何が正解で何が失敗かの判断基準

## 評価の運用

初期は人手評価のみ。LLM による品質数値化や `spec/e2e/` ハーネスへの自動接続は Phase 2B 以降に判断する。

## scenario の追加方法

1. `conversations/` に連番の JSON を追加する
2. `pnpm exec vitest run spec/corpus/corpus.spec.ts` でスキーマ検証を通す
```

- [ ] **Step 2: フォーマットと全体検証を実行する**

```bash
nr format
nr validate
```

Expected: format / lint / typecheck / unit / spec すべて PASS

- [ ] **Step 3: コミット**

```bash
git add spec/corpus/README.md
git commit -m "docs: describe corpus labels and manual evaluation workflow"
```

- [ ] **Step 4: push して PR を作る**

```bash
git push -u origin HEAD
gh pr create --fill
```

---

## この計画の範囲外

次のスライス（別計画）で扱う。

- `conversation_evaluate` job への置き換えと scope キー化（設計 §3.1）— corpus の `maxWaitMs` ラベルを `batchWindow` / `maxWait` の根拠として使う
- corpus を実行する自動ハーネス（`spec/e2e/` 接続、LLM 品質数値化）— Phase 2B 以降に判断
