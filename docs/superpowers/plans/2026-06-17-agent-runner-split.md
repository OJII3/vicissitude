# AgentRunner シーム保存分割 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1021 行の `AgentRunner`（`packages/agent/src/runner.ts`）から、メトリクス・compaction 判定・メッセージバッファの 3 つの内部責務を協調オブジェクト／純粋関数へ抽出し、行数と複雑度を下げる。

**Architecture:** 公開 API（`AiAgent`）と protected シーム（`sleep` / `waitForDebounce` / `nowProvider` / `pendingCompaction` / `startPollingLoop` / `triggerCompaction` / `forceSessionRotation` / `RunnerDeps` コンストラクタ）を一切変えない。約 8,100 行のテスト（`spec/agent/*.spec.ts` + `runner.test.ts`）はこのシームに白箱結合しているため、シームを保てば**テストは無変更で green を維持**する。抽出対象は「外部から観察されない内部ロジック」のみ。`AgentRunner` は抽出したコラボレータへ委譲する薄いオーケストレータになる。

**Tech Stack:** Bun, TypeScript, oxlint/oxfmt, `bun:test`。

**抽出しないもの（本 PR スコープ外）:** `startPollingLoop` のエラー戦略分岐（SESSION_RESTARTS reason の厳密一致を `runner-error-strategy.spec.ts` 等が検証しており、純粋関数化はリスクが高い）。`resolveSessionId` / `rotateSessionIfExpired` / `generateSessionSummary` のセッションライフサイクル（`sessionCreatedAt` / `hasStartedSession` をループが共有し、`forceSessionRotation` はテストがモック差し替えするため抽出不可）。これらは完了後に follow-up Issue を立てる。

**重要な不変条件（壊すと多数のテストが落ちる）:**

- `AgentRunner` の public: `send` / `ensurePolling` / `stop` / `requestSessionRotation` / `forceSessionRotation`。
- protected: `sleep` / `waitForDebounce` / `startPollingLoop` / `triggerCompaction` / `nowProvider` / `pendingCompaction`。
- private フィールド名 `abortController`（`runner.test.ts` が `@ts-expect-error` で直接参照）。
- `RunnerDeps` インターフェースの形（テストが全フィールドを渡す）。
- パッケージ export `@vicissitude/agent/runner` は `./src/runner.ts` のまま（新規ファイルはサブパス export 不要、`runner.ts` から相対 import）。
- 排出されるメトリクス（counter/gauge/histogram の名前・ラベル・呼び出し回数・outcome）と port 呼び出し回数・引数は完全一致させる。

---

## File Structure

新規ファイル（すべて `packages/agent/src/` 直下、`runner.ts` と co-locate）:

| ファイル                        | 責務                                                                                                                                                             | 行数目安 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `runner-prompt-metrics.ts`      | `PromptMetricsTracker` クラス。プロンプト lifecycle メトリクス（LLM_BUSY_SESSIONS / AI_REQUESTS / AI_REQUEST_DURATION）とラベル構築・フォールバック。            | ~80      |
| `runner-prompt-metrics.test.ts` | 上記のユニットテスト。                                                                                                                                           | ~90      |
| `runner-compaction.ts`          | `evaluateProactiveCompaction` / `isCompactionOnCooldown` の純粋関数。                                                                                            | ~55      |
| `runner-compaction.test.ts`     | 上記のユニットテスト。                                                                                                                                           | ~80      |
| `runner-message-buffer.ts`      | `MessageBuffer` クラス + `PendingMessage` / `DrainedMessages` 型 + `mergeMetricLabel`。蓄積メッセージとリトライ用 lastPrompt 状態の保持・drain・merge・requeue。 | ~110     |
| `runner-message-buffer.test.ts` | 上記のユニットテスト。                                                                                                                                           | ~110     |

`runner.ts` は上記 3 つへ委譲し、1021 → 約 770〜800 行へ縮小する。

---

## Task 1: PromptMetricsTracker を抽出する

**Files:**

- Create: `packages/agent/src/runner-prompt-metrics.ts`
- Modify: `packages/agent/src/runner.ts`（メトリクス系フィールド・メソッドを委譲へ置換）

- [ ] **Step 1: `runner-prompt-metrics.ts` を作成する**

```typescript
import { buildAgentMetricLabels, METRIC } from "@vicissitude/observability/metrics";
import type { MetricsCollector } from "@vicissitude/shared/types";

interface ActivePromptMetrics {
	labels: Record<string, string>;
	startedAt: number;
}

export type PromptOutcome = "success" | "error" | "cancelled" | "deleted";

export interface PromptMetricsConfig {
	metrics?: MetricsCollector;
	agentId: string;
	contextScopeId?: string;
	model: { providerId: string; modelId: string };
}

/**
 * AgentRunner のプロンプト lifecycle メトリクスとラベル構築を担う。
 * AgentRunner からは観察されないため、排出メトリクスの名前・ラベル・回数を
 * 旧 AgentRunner 実装と完全一致させること。
 */
export class PromptMetricsTracker {
	private active: ActivePromptMetrics | null = null;
	private lastLabels: Record<string, string> | null = null;
	private readonly metrics?: MetricsCollector;
	private readonly agentId: string;
	private readonly contextScopeId?: string;
	private readonly model: { providerId: string; modelId: string };

	constructor(config: PromptMetricsConfig) {
		this.metrics = config.metrics;
		this.agentId = config.agentId;
		this.contextScopeId = config.contextScopeId;
		this.model = config.model;
	}

	buildLabels(options: { trigger?: string; scopeId?: string } = {}): Record<string, string> {
		return buildAgentMetricLabels({
			agentId: this.agentId,
			scopeId: options.scopeId ?? this.contextScopeId,
			trigger: options.trigger ?? "session",
			providerId: this.model.providerId,
			modelId: this.model.modelId,
		});
	}

	labels(extra: Record<string, string> = {}): Record<string, string> {
		return {
			...(this.active?.labels ?? this.lastLabels ?? this.buildLabels()),
			...extra,
		};
	}

	/** プロンプト送信直前に次ターンのラベルをフォールバック用に予約する */
	setPendingLabels(trigger: string, scopeId: string | undefined): void {
		this.lastLabels = this.buildLabels({ trigger, scopeId });
	}

	start(trigger: string, scopeId: string | undefined): void {
		const labels = this.buildLabels({ trigger, scopeId });
		this.active = { labels, startedAt: performance.now() };
		this.lastLabels = null;
		this.metrics?.incrementGauge(METRIC.LLM_BUSY_SESSIONS, labels);
	}

	finalize(outcome: PromptOutcome): void {
		const active = this.active;
		if (!active) return;
		this.lastLabels = active.labels;
		if (this.metrics) {
			const labels = { ...active.labels, outcome };
			const duration = (performance.now() - active.startedAt) / 1000;
			this.metrics.incrementCounter(METRIC.AI_REQUESTS, labels);
			this.metrics.observeHistogram(METRIC.AI_REQUEST_DURATION, duration, labels);
			this.metrics.decrementGauge(METRIC.LLM_BUSY_SESSIONS, active.labels);
		}
		this.active = null;
	}
}
```

- [ ] **Step 2: `runner.ts` を委譲に置換する**

2-1. import に追加（先頭の import ブロック付近）:

```typescript
import { PromptMetricsTracker } from "./runner-prompt-metrics.ts";
```

2-2. `metrics` import から prompt lifecycle 専用のものは tracker へ移った。`runner.ts` 側で残る `METRIC` 用途は `SESSION_RESTARTS` / `SESSION_RETRIES` / `SESSION_ERRORS` のみ。`buildAgentMetricLabels` の import は不要になるので削除する（`classifyErrorType` / `inferScopeId` / `inferTrigger` / `METRIC` / `recordTokenMetrics` は残す）。

2-3. 削除する宣言:

- `interface ActivePromptMetrics { ... }`（旧 46-49 行）
- `type PromptOutcome = ...`（旧 51 行）
- フィールド `private activePromptMetrics: ActivePromptMetrics | null = null;`（旧 113 行）
- フィールド `private lastPromptMetricLabels: Record<string, string> | null = null;`（旧 114 行）
- メソッド `private buildMetricLabels(...)`（旧 205-215 行）
- メソッド `private metricLabels(...)`（旧 217-224 行）
- メソッド `private startPromptMetrics(...)`（旧 226-231 行）
- メソッド `private finalizePromptMetrics(...)`（旧 233-246 行）

2-4. フィールド追加（`private readonly metrics?: MetricsCollector;` の近く）:

```typescript
private readonly promptMetrics: PromptMetricsTracker;
```

2-5. コンストラクタ末尾（`this.nowProvider = ...;` の後）に追加:

```typescript
this.promptMetrics = new PromptMetricsTracker({
	metrics: deps.metrics,
	agentId: deps.agentId,
	contextScopeId: deps.contextScopeId,
	model: deps.profile.model,
});
```

2-6. 呼び出し置換（runner.ts 全体を grep して機械的に置換する）:

- `this.metricLabels(` → `this.promptMetrics.labels(`（全箇所。引数なし `this.metricLabels()` 含む）
- `this.finalizePromptMetrics(` → `this.promptMetrics.finalize(`（全箇所。`stop()` 内の `this.finalizePromptMetrics("cancelled")` 含む）
- `this.startPromptMetrics(trigger, scopeId)` → `this.promptMetrics.start(trigger, scopeId)`
- 旧 643 行 `this.lastPromptMetricLabels = this.buildMetricLabels({ trigger, scopeId });` → `this.promptMetrics.setPendingLabels(trigger, scopeId);`

> 注意: `recordTokenMetrics(this.metrics, event.tokens, this.metricLabels(), ...)`（旧 784-790, 812-818 行）は `this.metricLabels()` → `this.promptMetrics.labels()` に置換。`this.metrics` 引数はそのまま（runner は `metrics` フィールドを保持し続ける）。

- [ ] **Step 3: 既存テストが green か確認する**

Run: `nr fmt && nr test:unit && nr test:spec`
Expected: 既存の `spec/agent/*.spec.ts` と `runner.test.ts` がすべて PASS。特に `runner-llm-metrics.spec.ts` / `runner-retry-metrics.spec.ts` / `session-error-metrics.spec.ts` が green。

- [ ] **Step 4: PromptMetricsTracker のユニットテストを書く**

Create: `packages/agent/src/runner-prompt-metrics.test.ts`

```typescript
import { describe, expect, mock, test } from "bun:test";

import { PromptMetricsTracker } from "./runner-prompt-metrics.ts";

function createMetrics() {
	return {
		incrementCounter: mock(() => {}),
		addCounter: mock(() => {}),
		setGauge: mock(() => {}),
		incrementGauge: mock(() => {}),
		decrementGauge: mock(() => {}),
		observeHistogram: mock(() => {}),
	};
}

const config = {
	agentId: "guild-1",
	contextScopeId: "scope-1",
	model: { providerId: "p", modelId: "m" },
};

describe("PromptMetricsTracker", () => {
	test("buildLabels は agentId/trigger/scopeId/model を含む", () => {
		const tracker = new PromptMetricsTracker(config);
		const labels = tracker.buildLabels({ trigger: "user", scopeId: "s2" });
		expect(labels).toMatchObject({ agent_id: "guild-1", trigger: "user" });
	});

	test("labels は active → pending → buildLabels の順でフォールバックする", () => {
		const tracker = new PromptMetricsTracker(config);
		// active も pending も無ければ buildLabels(session)
		expect(tracker.labels().trigger).toBe("session");
		// pending を予約すると pending が使われる
		tracker.setPendingLabels("user", "s2");
		expect(tracker.labels().trigger).toBe("user");
		// start すると active が優先される
		tracker.start("internal", "s3");
		expect(tracker.labels().trigger).toBe("internal");
	});

	test("start は LLM_BUSY_SESSIONS をインクリメントする", () => {
		const metrics = createMetrics();
		const tracker = new PromptMetricsTracker({ ...config, metrics });
		tracker.start("user", "s2");
		expect(metrics.incrementGauge).toHaveBeenCalledTimes(1);
	});

	test("finalize は AI_REQUESTS/AI_REQUEST_DURATION を記録し LLM_BUSY_SESSIONS をデクリメントする", () => {
		const metrics = createMetrics();
		const tracker = new PromptMetricsTracker({ ...config, metrics });
		tracker.start("user", "s2");
		tracker.finalize("success");
		expect(metrics.incrementCounter).toHaveBeenCalledTimes(1);
		expect(metrics.observeHistogram).toHaveBeenCalledTimes(1);
		expect(metrics.decrementGauge).toHaveBeenCalledTimes(1);
		const counterCall = metrics.incrementCounter.mock.calls[0];
		expect(counterCall?.[1]).toMatchObject({ outcome: "success" });
	});

	test("active が無いとき finalize は何もしない", () => {
		const metrics = createMetrics();
		const tracker = new PromptMetricsTracker({ ...config, metrics });
		tracker.finalize("error");
		expect(metrics.incrementCounter).toHaveBeenCalledTimes(0);
	});
});
```

- [ ] **Step 5: ユニットテストを実行する**

Run: `nr test:unit`
Expected: `runner-prompt-metrics.test.ts` が PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/agent/src/runner-prompt-metrics.ts packages/agent/src/runner-prompt-metrics.test.ts packages/agent/src/runner.ts
git commit -m "refactor(agent): AgentRunner のプロンプトメトリクスを PromptMetricsTracker へ抽出する"
```

---

## Task 2: proactive compaction 判定を純粋関数へ抽出する

**Files:**

- Create: `packages/agent/src/runner-compaction.ts`
- Modify: `packages/agent/src/runner.ts`（`shouldProactiveCompact` 削除、`tryProactiveCompact` / `triggerCompaction` を委譲へ）

- [ ] **Step 1: `runner-compaction.ts` を作成する**

```typescript
import { JST_OFFSET_MS } from "@vicissitude/shared/functions";

export interface ProactiveCompactionInput {
	compactionTokenThreshold: number | undefined;
	now: number;
	lastCompactionAt: number | null;
	compactionCooldownMs: number;
	sessionCreatedAt: number | null;
	sessionMaxAgeMs: number;
	tokens: { input: number; output: number } | undefined;
}

/** 直近 compaction からクールダウン期間内か */
export function isCompactionOnCooldown(
	now: number,
	lastCompactionAt: number | null,
	cooldownMs: number,
): boolean {
	return lastCompactionAt !== null && now - lastCompactionAt < cooldownMs;
}

/**
 * proactive compaction を発火すべきか判定する。
 * - "threshold": トークン閾値超過
 * - "midnight": 深夜帯(2-5 JST) かつセッション半寿命 & トークン半閾値
 * - "cooldown": クールダウン中（呼び出し元は debug ログを出す）
 * - "none": 発火しない
 */
export function evaluateProactiveCompaction(
	input: ProactiveCompactionInput,
): "threshold" | "midnight" | "cooldown" | "none" {
	if (input.compactionTokenThreshold === undefined) return "none";

	if (isCompactionOnCooldown(input.now, input.lastCompactionAt, input.compactionCooldownMs)) {
		return "cooldown";
	}

	if (input.tokens) {
		const total = input.tokens.input + input.tokens.output;
		if (total >= input.compactionTokenThreshold) return "threshold";
	}

	const jstHour = new Date(input.now + JST_OFFSET_MS).getUTCHours();
	if (jstHour >= 2 && jstHour < 5 && input.sessionCreatedAt !== null && input.tokens) {
		const total = input.tokens.input + input.tokens.output;
		const age = input.now - input.sessionCreatedAt;
		if (age >= input.sessionMaxAgeMs / 2 && total >= input.compactionTokenThreshold / 2) {
			return "midnight";
		}
	}

	return "none";
}
```

- [ ] **Step 2: `runner.ts` を委譲に置換する**

2-1. import 追加:

```typescript
import { evaluateProactiveCompaction, isCompactionOnCooldown } from "./runner-compaction.ts";
```

2-2. `shouldProactiveCompact` メソッド（旧 880-911 行）を**削除**する。

2-3. `tryProactiveCompact`（旧 864-878 行）を以下に置換する:

```typescript
private async tryProactiveCompact(event: OpencodeSessionEvent & { type: "idle" }): Promise<void> {
	const decision = evaluateProactiveCompaction({
		compactionTokenThreshold: this.compactionTokenThreshold,
		now: this.nowProvider(),
		lastCompactionAt: this.lastCompactionAt,
		compactionCooldownMs: this.compactionCooldownMs,
		sessionCreatedAt: this.sessionCreatedAt,
		sessionMaxAgeMs: this.sessionMaxAgeMs,
		tokens: event.tokens,
	});
	if (decision === "cooldown") {
		this.logger.debug(
			`[${this.profile.name}:${this.agentId}] proactive compaction skipped: cooldown`,
		);
		return;
	}
	if (decision === "none") return;
	const sessionId = this.sessionStore.get(this.profile.name, this.sessionKey);
	if (!sessionId) return;
	try {
		await this.sessionPort.summarizeSession(sessionId, this.profile.model);
		this.lastCompactionAt = this.nowProvider();
		this.pendingSystemReinject = true;
		this.logger.info(`[${this.profile.name}:${this.agentId}] proactive compaction completed`);
	} catch (err) {
		this.logger.warn(
			`[${this.profile.name}:${this.agentId}] proactive compaction failed, continuing normally: ${formatErrorMessage(err)}`,
		);
	}
}
```

2-4. `triggerCompaction`（旧 842-861 行）のクールダウンチェック行:

```typescript
if (this.lastCompactionAt !== null && now - this.lastCompactionAt < this.compactionCooldownMs) {
	return;
}
```

を以下に置換する:

```typescript
if (isCompactionOnCooldown(now, this.lastCompactionAt, this.compactionCooldownMs)) {
	return;
}
```

- [ ] **Step 3: 既存テストが green か確認する**

Run: `nr fmt && nr test:unit && nr test:spec`
Expected: `runner-compaction.spec.ts` / `runner-break-compaction.spec.ts` を含め全 PASS。

- [ ] **Step 4: ユニットテストを書く**

Create: `packages/agent/src/runner-compaction.test.ts`

```typescript
import { describe, expect, test } from "bun:test";

import { evaluateProactiveCompaction, isCompactionOnCooldown } from "./runner-compaction.ts";

const base = {
	compactionTokenThreshold: 1000,
	now: 0,
	lastCompactionAt: null,
	compactionCooldownMs: 1_800_000,
	sessionCreatedAt: null,
	sessionMaxAgeMs: 3_600_000,
	tokens: undefined,
};

describe("isCompactionOnCooldown", () => {
	test("lastCompactionAt が null なら常に false", () => {
		expect(isCompactionOnCooldown(100, null, 50)).toBe(false);
	});
	test("クールダウン期間内なら true", () => {
		expect(isCompactionOnCooldown(100, 80, 50)).toBe(true);
	});
	test("クールダウン期間経過後は false", () => {
		expect(isCompactionOnCooldown(200, 80, 50)).toBe(false);
	});
});

describe("evaluateProactiveCompaction", () => {
	test("閾値未設定なら none", () => {
		expect(evaluateProactiveCompaction({ ...base, compactionTokenThreshold: undefined })).toBe(
			"none",
		);
	});
	test("クールダウン中なら cooldown", () => {
		expect(
			evaluateProactiveCompaction({
				...base,
				now: 100,
				lastCompactionAt: 50,
				compactionCooldownMs: 1000,
			}),
		).toBe("cooldown");
	});
	test("トークン閾値超過なら threshold", () => {
		expect(evaluateProactiveCompaction({ ...base, tokens: { input: 600, output: 600 } })).toBe(
			"threshold",
		);
	});
	test("深夜帯(JST 3時)かつ半寿命・半閾値なら midnight", () => {
		// JST 3:00 = UTC 18:00。UTC epoch から 18時間。
		const utc3JST = Date.UTC(2026, 0, 2, 18, 0, 0);
		expect(
			evaluateProactiveCompaction({
				...base,
				now: utc3JST,
				sessionCreatedAt: utc3JST - 1_800_001, // 半寿命超過
				tokens: { input: 300, output: 300 }, // 半閾値(500)超過
			}),
		).toBe("midnight");
	});
	test("条件を満たさなければ none", () => {
		expect(evaluateProactiveCompaction({ ...base, tokens: { input: 1, output: 1 } })).toBe("none");
	});
});
```

- [ ] **Step 5: ユニットテストを実行する**

Run: `nr test:unit`
Expected: `runner-compaction.test.ts` が PASS。深夜帯テストが fal する場合は `now` の JST 換算（`+JST_OFFSET_MS` 後の UTC hour が 2〜4）を確認して `now` を調整する。

- [ ] **Step 6: コミットする**

```bash
git add packages/agent/src/runner-compaction.ts packages/agent/src/runner-compaction.test.ts packages/agent/src/runner.ts
git commit -m "refactor(agent): proactive compaction 判定を純粋関数へ抽出する"
```

---

## Task 3: MessageBuffer を抽出する

**Files:**

- Create: `packages/agent/src/runner-message-buffer.ts`
- Modify: `packages/agent/src/runner.ts`（メッセージキュー・lastPrompt 状態を委譲へ）

- [ ] **Step 1: `runner-message-buffer.ts` を作成する**

```typescript
import type { Attachment } from "@vicissitude/shared/types";

export interface PendingMessage {
	text: string;
	attachments?: Attachment[];
	trigger: string;
	scopeId?: string;
}

export interface DrainedMessages {
	text: string;
	attachments: Attachment[];
	trigger: string;
	scopeId?: string;
}

/** 複数値をメトリクスラベル用に集約する。空→fallback / 1種→その値 / 複数→"mixed" */
export function mergeMetricLabel(values: Array<string | undefined>, fallback: string): string {
	const unique = [...new Set(values.filter((value): value is string => !!value))];
	if (unique.length === 0) return fallback;
	if (unique.length === 1) return unique[0] ?? fallback;
	return "mixed";
}

/**
 * AgentRunner の受信メッセージバッファとリトライ用 lastPrompt 状態を保持する。
 * 待機(waitForMessages/waitForDebounce)のタイミング制御は AgentRunner 側のシームに残し、
 * 本クラスはデータ保持・drain・merge・requeue のみを担う（外部から観察されない）。
 */
export class MessageBuffer {
	private pending: PendingMessage[] = [];
	private botPending = false;
	private lastText: string | null = null;
	private lastAttachments: Attachment[] | null = null;
	private lastTrigger: string | null = null;
	private lastScopeId: string | null = null;

	enqueue(message: PendingMessage, isBot: boolean): void {
		this.pending.push(message);
		if (isBot) this.botPending = true;
	}

	get size(): number {
		return this.pending.length;
	}

	get hasBotPending(): boolean {
		return this.botPending;
	}

	get hasLastPrompt(): boolean {
		return this.lastText !== null;
	}

	/** 通常フロー: 蓄積メッセージをまとめて取り出し、bot フラグをリセットする */
	drain(fallbackScopeId: string | undefined): DrainedMessages {
		const items = this.pending.splice(0);
		this.botPending = false;
		return {
			text: items.map((m) => m.text).join("\n---\n"),
			attachments: items.flatMap((m) => m.attachments ?? []),
			trigger: mergeMetricLabel(
				items.map((m) => m.trigger),
				"unknown",
			),
			scopeId: mergeMetricLabel(
				items.map((m) => m.scopeId),
				fallbackScopeId ?? "none",
			),
		};
	}

	/** リトライフロー: lastPrompt を再利用し、新着があればマージする */
	drainForRetry(fallbackScopeId: string | undefined): DrainedMessages {
		const lastText = this.lastText ?? "";
		const drained = this.drain(fallbackScopeId);
		const hasDrained = drained.text.length > 0 || drained.attachments.length > 0;
		return {
			text: drained.text ? `${lastText}\n---\n${drained.text}` : lastText,
			attachments: [...(this.lastAttachments ?? []), ...drained.attachments],
			trigger: mergeMetricLabel(
				[this.lastTrigger ?? undefined, hasDrained ? drained.trigger : undefined],
				"unknown",
			),
			scopeId: mergeMetricLabel(
				[this.lastScopeId ?? undefined, hasDrained ? drained.scopeId : undefined],
				fallbackScopeId ?? "none",
			),
		};
	}

	setLastPrompt(
		text: string,
		attachments: Attachment[],
		trigger: string,
		scopeId: string | undefined,
	): void {
		this.lastText = text;
		this.lastAttachments = attachments;
		this.lastTrigger = trigger;
		this.lastScopeId = scopeId ?? null;
	}

	clearLastPrompt(): void {
		this.lastText = null;
		this.lastAttachments = null;
		this.lastTrigger = null;
		this.lastScopeId = null;
	}

	/** 中断時に直前プロンプトを先頭へ戻す（lastPrompt が無ければ何もしない） */
	requeueLastPrompt(): void {
		if (this.lastText === null) return;
		this.pending.unshift({
			text: this.lastText,
			attachments: this.lastAttachments ?? undefined,
			trigger: this.lastTrigger ?? "unknown",
			scopeId: this.lastScopeId ?? undefined,
		});
	}
}
```

- [ ] **Step 2: `runner.ts` を委譲に置換する**

2-1. import 追加:

```typescript
import { MessageBuffer } from "./runner-message-buffer.ts";
```

2-2. 削除する宣言:

- `interface PendingMessage { ... }`（旧 39-44 行）
- `function mergeMetricLabel(...)`（旧 53-58 行）
- フィールド `private pendingMessages: PendingMessage[] = [];`（旧 103 行）
- フィールド `private hasBotPending = false;`（旧 111 行）
- フィールド群 `lastPromptText` / `lastPromptAttachments` / `lastPromptTrigger` / `lastPromptScopeId`（旧 106-109 行）
- メソッド `private clearLastPrompt()`（旧 590-595 行）
- メソッド `private drainMessages()`（旧 754-774 行）

2-3. フィールド追加（`pendingResolve` の近く）:

```typescript
private readonly messages = new MessageBuffer();
```

> `pendingResolve` / `pendingDebounceResolve` は待機シームに属するため runner に残す。

2-4. `send`（旧 159-192 行）を以下に置換する:

```typescript
send(options: SendOptions): Promise<AgentResponse> {
	this.messages.enqueue(
		{
			text: options.message,
			attachments: options.attachments,
			trigger: inferTrigger(options.sessionKey),
			scopeId: options.scopeId ?? inferScopeId(options.sessionKey) ?? this.contextScopeId,
		},
		options.isBot ?? false,
	);
	this.pendingResolve?.();
	this.pendingDebounceResolve?.();

	// 推論中（sessionWatch が pending）なら中断して旧メッセージを保全。
	// ただし Discord 送信系 tool が開始済みなら、外部副作用が巻き戻せないため
	// 現在の turn を最後まで待ち、新着は次 turn に回す。
	if (this.sessionWatch) {
		if (this.promptHasUninterruptibleSideEffect) {
			this.ensurePolling();
			return Promise.resolve({ text: "", sessionId: "queued" });
		}
		this.messages.requeueLastPrompt();
		this.messages.clearLastPrompt();
		this.sessionAbortController?.abort();
	}

	this.ensurePolling();
	return Promise.resolve({ text: "", sessionId: "queued" });
}
```

2-5. `handleBackgroundTaskFailure`（旧 538-588 行）の `this.pendingMessages.push({...})`（旧 558-570 行）を:

```typescript
this.messages.enqueue(
	{
		text: `<internal_message>
shell-worker background task failed.
task_id: ${activity.taskId ?? "unknown"}
state: ${activity.state ?? "unknown"}
reason: ${activity.reason}
detail: ${activity.message}

この shell-worker 作業を成功・開始済みとして報告してはいけません。Discord には失敗として短く報告してください。
</internal_message>`,
		trigger: "internal",
		scopeId: this.contextScopeId,
	},
	false,
);
```

に置換し、続く requeue 部分（旧 578-586 行）を:

```typescript
this.messages.requeueLastPrompt();
this.messages.clearLastPrompt();
this.sessionAbortController?.abort();
```

に置換する（旧 `if (this.lastPromptText !== null) { unshift... }` ブロックは `requeueLastPrompt()` が内部で null ガードするため不要）。

2-6. `ensureSessionStarted`（旧 597-694 行）のメッセージ取得部（旧 610-657 行）を以下に置換する:

```typescript
let text: string;
let attachments: Attachment[];
let trigger: string;
let scopeId: string | undefined;
if (!this.messages.hasLastPrompt) {
	this.logger.info(
		`[${this.profile.name}:${this.agentId}] waiting for messages... (hasStartedSession=${this.hasStartedSession})`,
	);
	await this.waitForMessages(signal);
	if (signal.aborted) {
		this.logger.info(`[${this.profile.name}:${this.agentId}] waitForMessages aborted`);
		return;
	}
	await this.waitForDebounce(signal);
	if (signal.aborted) return;
	const drained = this.messages.drain(this.contextScopeId);
	if (!drained.text && drained.attachments.length === 0) return;
	text = drained.text;
	attachments = drained.attachments;
	trigger = drained.trigger;
	scopeId = drained.scopeId;
} else {
	// リトライ: 前回のテキストを再利用し、新着メッセージがあれば追加
	const drained = this.messages.drainForRetry(this.contextScopeId);
	text = drained.text;
	attachments = drained.attachments;
	trigger = drained.trigger;
	scopeId = drained.scopeId;
}

this.promptMetrics.setPendingLabels(trigger, scopeId);
this.logger.info(`[${this.profile.name}:${this.agentId}] messages received, sending prompt`);

if (this.attachmentProcessor) {
	const processed = await this.attachmentProcessor.process(text, attachments);
	if (signal.aborted) return;
	text = processed.text;
	attachments = processed.attachments;
}

// lastPrompt にはメッセージ本文のみを保存し、リトライ時の二重注入を防ぐ
this.messages.setLastPrompt(text, attachments, trigger, scopeId);
```

> このブロックは Task 1 で `this.promptMetrics.setPendingLabels(...)` に置換済みの想定。Task 1 を先に終えていれば旧 643 行は既に置換されている。

2-7. `waitForMessages`（旧 696-706 行）の `if (this.pendingMessages.length > 0)` を `if (this.messages.size > 0)` に置換する。

2-8. `waitForDebounce`（旧 709-733 行）内の参照を置換する:

- `this.hasBotPending`（旧 711, 729 行）→ `this.messages.hasBotPending`
- `this.pendingMessages.length`（旧 712, 729, 731 行、計 3 箇所）→ `this.messages.size`

2-9. ループ内に残る `this.clearLastPrompt()` 呼び出し（旧 186, 293, 308, 337, 356, 373, 428, 586 行）を**すべて** `this.messages.clearLastPrompt()` に置換する（grep `this.clearLastPrompt(` で漏れ確認）。

- [ ] **Step 3: 既存テストが green か確認する**

Run: `nr fmt && nr test:unit && nr test:spec`
Expected: 全 PASS。特に `runner-debounce.spec.ts`（デバウンス・推論中断・bot 延長）と `runner-background-task-failure.spec.ts` が green。落ちた場合は drain の `\n---\n` 区切り・mergeMetricLabel のフォールバック・requeue の順序を旧実装と突き合わせる。

- [ ] **Step 4: ユニットテストを書く**

Create: `packages/agent/src/runner-message-buffer.test.ts`

```typescript
import { describe, expect, test } from "bun:test";

import { MessageBuffer, mergeMetricLabel } from "./runner-message-buffer.ts";

describe("mergeMetricLabel", () => {
	test("空配列は fallback を返す", () => {
		expect(mergeMetricLabel([undefined, undefined], "fb")).toBe("fb");
	});
	test("1種類なら その値を返す", () => {
		expect(mergeMetricLabel(["a", undefined, "a"], "fb")).toBe("a");
	});
	test("複数種類なら mixed を返す", () => {
		expect(mergeMetricLabel(["a", "b"], "fb")).toBe("mixed");
	});
});

describe("MessageBuffer", () => {
	test("enqueue と size と drain の基本動作", () => {
		const buf = new MessageBuffer();
		buf.enqueue({ text: "hello", trigger: "user", scopeId: "s1" }, false);
		buf.enqueue({ text: "world", trigger: "user", scopeId: "s1" }, false);
		expect(buf.size).toBe(2);
		const drained = buf.drain("none");
		expect(drained.text).toBe("hello\n---\nworld");
		expect(drained.trigger).toBe("user");
		expect(drained.scopeId).toBe("s1");
		expect(buf.size).toBe(0);
	});

	test("drain は trigger/scopeId が混在すると mixed になる", () => {
		const buf = new MessageBuffer();
		buf.enqueue({ text: "a", trigger: "user", scopeId: "s1" }, false);
		buf.enqueue({ text: "b", trigger: "internal", scopeId: "s2" }, false);
		const drained = buf.drain("none");
		expect(drained.trigger).toBe("mixed");
		expect(drained.scopeId).toBe("mixed");
	});

	test("hasBotPending は bot 投入で立ち drain でリセットされる", () => {
		const buf = new MessageBuffer();
		buf.enqueue({ text: "x", trigger: "bot" }, true);
		expect(buf.hasBotPending).toBe(true);
		buf.drain("none");
		expect(buf.hasBotPending).toBe(false);
	});

	test("setLastPrompt / hasLastPrompt / drainForRetry がマージする", () => {
		const buf = new MessageBuffer();
		buf.setLastPrompt("orig", [], "user", "s1");
		expect(buf.hasLastPrompt).toBe(true);
		buf.enqueue({ text: "follow", trigger: "user", scopeId: "s1" }, false);
		const drained = buf.drainForRetry("none");
		expect(drained.text).toBe("orig\n---\nfollow");
	});

	test("新着が無ければ drainForRetry は lastText のみを返す", () => {
		const buf = new MessageBuffer();
		buf.setLastPrompt("orig", [], "user", "s1");
		const drained = buf.drainForRetry("none");
		expect(drained.text).toBe("orig");
	});

	test("requeueLastPrompt は先頭へ戻し、clearLastPrompt 後は何もしない", () => {
		const buf = new MessageBuffer();
		buf.setLastPrompt("orig", [], "user", "s1");
		buf.requeueLastPrompt();
		expect(buf.size).toBe(1);
		buf.clearLastPrompt();
		expect(buf.hasLastPrompt).toBe(false);
		buf.requeueLastPrompt();
		expect(buf.size).toBe(1); // 増えない
	});
});
```

- [ ] **Step 5: ユニットテストを実行する**

Run: `nr test:unit`
Expected: `runner-message-buffer.test.ts` が PASS。

- [ ] **Step 6: コミットする**

```bash
git add packages/agent/src/runner-message-buffer.ts packages/agent/src/runner-message-buffer.test.ts packages/agent/src/runner.ts
git commit -m "refactor(agent): AgentRunner のメッセージキューを MessageBuffer へ抽出する"
```

---

## Task 4: 最終検証とクリーンアップ

**Files:**

- Modify: `packages/agent/src/runner.ts`（不要 import / oxlint-disable ヘッダの見直し）

- [ ] **Step 1: 未使用 import を削除する**

`runner.ts` 先頭の `oxlint-disable max-lines, max-lines-per-function` コメント（旧 1 行目）は、抽出後も `startPollingLoop` が長い場合は残す。`buildAgentMetricLabels`（Task 1 で不要化）など未使用 import が残っていないか確認する。

Run: `nr lint`
Expected: 未使用 import エラーが出れば削除。`max-lines` が解消していれば disable ディレクティブを外す（oxlint が "unused disable" を報告する場合は外す）。

- [ ] **Step 2: 全体検証**

Run: `nr fmt && nr validate && nr test`
Expected: `fmt:check` + `lint` + `check`（型）+ 全テスト PASS。`runner.ts` の行数を `wc -l packages/agent/src/runner.ts` で確認し、1021 → 770〜800 行程度に減っていること。

- [ ] **Step 3: follow-up Issue を立てる**

本 PR スコープ外として以下を GitHub Issue 化する（1 Issue = 1 トピック）:

- `startPollingLoop` のエラー戦略分岐（SESSION_RESTARTS reason 判定）の純粋関数化。`help wanted` 付与（spec 書き換えを伴うため設計判断要）。
- `resolveSessionId` / `rotateSessionIfExpired` / `generateSessionSummary` のセッションライフサイクル分離。

```bash
gh issue create --title "refactor(agent): AgentRunner のエラー戦略分岐を純粋関数化する" --label "help wanted" --body "..."
gh issue create --title "refactor(agent): AgentRunner のセッションライフサイクルを分離する" --body "..."
```

- [ ] **Step 4: push して PR を作成する**

```bash
git push -u origin refactor/agent-runner-split
gh pr create --title "refactor(agent): AgentRunner の責務を協調オブジェクト・純粋関数へ分割する" --body "..."
```

---

## Self-Review チェック結果

- **スコープ網羅:** メトリクス(Task1) / compaction判定(Task2) / メッセージバッファ(Task3) / 検証(Task4) を網羅。ループのエラー戦略・セッションライフサイクルは明示的にスコープ外として Issue 化。
- **シーム不変条件:** `sleep` / `waitForDebounce` / `nowProvider` / `pendingCompaction` / `startPollingLoop` / `triggerCompaction` / `forceSessionRotation` / `RunnerDeps` / private `abortController` は変更しない。テスト無変更で green を維持。
- **型整合:** `PromptMetricsTracker`（buildLabels/labels/setPendingLabels/start/finalize）、`MessageBuffer`（enqueue/size/hasBotPending/hasLastPrompt/drain/drainForRetry/setLastPrompt/clearLastPrompt/requeueLastPrompt）、`evaluateProactiveCompaction`/`isCompactionOnCooldown` のシグネチャは Task 内で一貫。
- **プレースホルダ:** なし（全コード実体を記載）。`gh ... --body "..."` のみ実行時に本文を埋める。
