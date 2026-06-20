# Issue #1083 parseAgentId 統一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `inferAgentKind` / `inferScopeIdFromAgentId` を `parseAgentId` 経由に統一し、agentId 規約の単一ソース化を達成する。

**Architecture:** `parseAgentId` に `{ strict: boolean }` オプションを追加し、現状の緩い/厳格な agentId パースを切り替える。`inferAgentKind` は `platform`/`role` からマップし、`inferScopeIdFromAgentId` は `scopeId` フィールドを直接返す。`spec/agent/runner-llm-metrics.spec.ts` の agentId を厳格モード規約 (`"discord:111"`) に揃え、`inferAgentKind` が `parseAgentId(agentId, { strict: false })` 経由で同じ結果を返すことを spec テストで保証する。

**Tech Stack:** TypeScript, Bun, oxlint, oxfmt

---

## File Structure

### Modify

- `packages/shared/src/namespace.ts` — `parseAgentId` に `strict` オプション追加
- `packages/observability/src/agent-labels.ts` — `inferAgentKind` / `inferScopeIdFromAgentId` を `parseAgentId` 経由に書き換え
- `spec/agent/runner-llm-metrics.spec.ts` — agentId を `"discord:111"` / `"discord:heartbeat:111"` に変更

### Create

- `spec/shared/namespace-parse-agent-id.spec.ts` — `parseAgentId` の `strict` モード/緩いモードの挙動を検証する spec テスト
- `spec/observability/agent-labels.spec.ts` — `inferAgentKind` / `buildAgentMetricLabels` が `parseAgentId(..., { strict: false })` 経由でも同じ結果を返すことを検証する spec テスト

---

## Task 1: `parseAgentId` に `strict` オプションを追加

**Files:**

- Modify: `packages/shared/src/namespace.ts:152-180`

- [ ] **Step 1: `parseAgentId` のシグネチャとロジックを変更**

```typescript
export interface ParseAgentIdOptions {
	/** true なら guildId / userId / web-scope 部を正規表現で厳格検証する。デフォルト true。 */
	readonly strict?: boolean;
}

export function parseAgentId(
	agentId: string | null | undefined,
	options: ParseAgentIdOptions = {},
): ParsedAgentId {
	const strict = options.strict ?? true;
	if (!agentId) return null;
	if (/^internal(?::.+)?$/.test(agentId)) {
		return { platform: "internal" };
	}
	const dm = agentId.match(/^discord:dm:([^:]+)$/);
	if (dm?.[1]) {
		const userId = dm[1];
		if (strict && !DISCORD_USER_ID_RE.test(userId)) return null;
		return { platform: "discord", role: "polling", scopeId: `discord:dm:${userId}` };
	}
	const m = agentId.match(/^discord:(?:(heartbeat):)?([^:]+)$/);
	if (m?.[2]) {
		const role = (m[1] ?? "polling") as DiscordAgentRole;
		const guildId = m[2];
		if (strict && !DISCORD_GUILD_ID_RE.test(guildId)) return null;
		if (strict) {
			return { platform: "discord", role, scopeId: discordScopeId(guildId) };
		}
		return { platform: "discord", role, scopeId: `discord:guild:${guildId}` };
	}
	const web = agentId.match(/^web:(.+)$/);
	if (web?.[1] && (!strict || AGENT_SCOPE_ID_RE.test(agentId))) {
		return { platform: "web", scopeId: agentId };
	}
	return null;
}
```

- [ ] **Step 2: 既存呼び出しが壊れないか確認**

`parseAgentId` を呼んでいるのは `resolveNamespaceFromAgentId` のみ。strict デフォルト true なので既存挙動は変わらない。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/namespace.ts
git commit -m "feat(shared): parseAgentId に strict オプションを追加"
```

## Task 2: `parseAgentId` の spec テストを追加

**Files:**

- Create: `spec/shared/namespace-parse-agent-id.spec.ts`

- [ ] **Step 1: spec テストを書く**

```typescript
import { describe, expect, test } from "bun:test";

import { parseAgentId } from "@vicissitude/shared/namespace";

describe("parseAgentId", () => {
	describe("strict mode (default)", () => {
		test("discord polling agentId をパースできる", () => {
			expect(parseAgentId("discord:111")).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:guild:111",
			});
		});

		test("discord heartbeat agentId をパースできる", () => {
			expect(parseAgentId("discord:heartbeat:111")).toEqual({
				platform: "discord",
				role: "heartbeat",
				scopeId: "discord:guild:111",
			});
		});

		test("discord DM agentId をパースできる", () => {
			expect(parseAgentId("discord:dm:222")).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:dm:222",
			});
		});

		test("guildId が数字でない場合は null", () => {
			expect(parseAgentId("discord:guild-1")).toBeNull();
		});

		test("web agentId はスコープ形式なら通る", () => {
			expect(parseAgentId("web:local")).toEqual({
				platform: "web",
				scopeId: "web:local",
			});
		});

		test("不正な web agentId は null", () => {
			expect(parseAgentId("web:")).toBeNull();
		});

		test("internal agentId はパースできる", () => {
			expect(parseAgentId("internal:anything")).toEqual({ platform: "internal" });
		});

		test("null/undefined/空文字は null", () => {
			expect(parseAgentId(null)).toBeNull();
			expect(parseAgentId(undefined)).toBeNull();
			expect(parseAgentId("")).toBeNull();
		});
	});

	describe("loose mode (strict: false)", () => {
		test("数字でない guildId もそのまま scopeId に詰める", () => {
			expect(parseAgentId("discord:guild-1", { strict: false })).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:guild:guild-1",
			});
		});

		test("heartbeat の緩い形式も scopeId に詰める", () => {
			expect(parseAgentId("discord:heartbeat:guild-1", { strict: false })).toEqual({
				platform: "discord",
				role: "heartbeat",
				scopeId: "discord:guild:guild-1",
			});
		});

		test("DM ユーザー ID も数字でなくても scopeId に詰める", () => {
			expect(parseAgentId("discord:dm:user-x", { strict: false })).toEqual({
				platform: "discord",
				role: "polling",
				scopeId: "discord:dm:user-x",
			});
		});
	});
});
```

- [ ] **Step 2: テスト実行して通過確認**

Run: `nr test:spec -- spec/shared/namespace-parse-agent-id.spec.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add spec/shared/namespace-parse-agent-id.spec.ts
git commit -m "test(shared): parseAgentId の strict/loose モードを検証する"
```

## Task 3: `inferAgentKind` / `inferScopeIdFromAgentId` を `parseAgentId` 経由に書き換え

**Files:**

- Modify: `packages/observability/src/agent-labels.ts:1-93`

- [ ] **Step 1: `agent-labels.ts` を書き換える**

```typescript
import { parseAgentId, type DiscordAgentRole } from "@vicissitude/shared/namespace";

// ─── Agent Metric Labels ────────────────────────────────────────

export interface AgentMetricLabelOptions {
	agentId: string;
	scopeId?: string;
	sessionKey?: string;
	trigger?: string;
	providerId: string;
	modelId: string;
}

/**
 * parseAgentId の結果プラットフォームを agent_kind ラベルにマップする。
 * `inferAgentKind` / `inferScopeIdFromAgentId` の単一ソース。
 */
function agentKindFromPlatform(
	platform: "discord" | "web" | "internal",
	role: DiscordAgentRole | undefined,
): string {
	if (platform === "discord") return role === "heartbeat" ? "discord_heartbeat" : "discord";
	if (platform === "web") return "web";
	return "internal";
}

/**
 * agentId の表面識別子。`parseAgentId` を緩いモードで呼び、観測的な
 * プレフィックス分類を行う。strict モードと無関係に agentId 規約が
 * 緩くても kind を導出できることが要件。
 */
export function inferAgentKind(agentId: string): string {
	const parsed = parseAgentId(agentId, { strict: false });
	if (!parsed) return "unknown";
	return agentKindFromPlatform(parsed.platform, parsed.role);
}

/**
 * sessionKey から trigger を導出する。session-key 規約は shared/namespace に
 * 集約済み（`HEARTBEAT_SESSION_PREFIX`）。trigger の判別は sessionKey の
 * 表面パターンに基づく観測的な分類。
 */
export function inferTrigger(sessionKey: string): string {
	if (sessionKey === "home" || sessionKey.endsWith(":_channel")) return "home";
	if (sessionKey === "dm" || sessionKey.startsWith("discord:dm:")) return "dm";
	if (sessionKey.startsWith("system:heartbeat:")) return "heartbeat";
	if (sessionKey.startsWith("discord:heartbeat:")) return "heartbeat";
	if (sessionKey === "mention" || sessionKey.startsWith("discord:")) return "mention";
	if (sessionKey.startsWith("minecraft:")) return "minecraft";
	if (sessionKey.startsWith("web:")) return "mention";
	return "unknown";
}

/** sessionKey から scopeId を導出する。 */
export function inferScopeId(sessionKey: string): string | undefined {
	const heartbeatScopeKey = scopeKeyFromHeartbeatSessionKey(sessionKey);
	if (heartbeatScopeKey !== null) return heartbeatScopeKey;

	if (sessionKey.startsWith("discord:guild:")) {
		return sessionKey;
	}

	if (sessionKey.startsWith("discord:dm:")) {
		return sessionKey;
	}

	if (sessionKey.startsWith("discord:")) {
		const [, first, second] = sessionKey.split(":");
		if (first === "dm") return second ? `discord:dm:${second}` : undefined;
		const discordId = first === "heartbeat" ? second : first;
		return discordId ? `discord:guild:${discordId}` : undefined;
	}

	return undefined;
}

/**
 * agentId から scopeId を導出する。`parseAgentId` 緩いモードの scopeId を
 * そのまま利用する。null の場合は undefined を返す。
 */
function inferScopeIdFromAgentId(agentId: string): string | undefined {
	const parsed = parseAgentId(agentId, { strict: false });
	if (!parsed || parsed.platform === "internal") return undefined;
	return parsed.scopeId;
}

export function buildAgentMetricLabels(options: AgentMetricLabelOptions): Record<string, string> {
	const sessionScopeId = options.sessionKey ? inferScopeId(options.sessionKey) : undefined;
	const scopeId =
		options.scopeId ?? sessionScopeId ?? inferScopeIdFromAgentId(options.agentId) ?? "none";
	const trigger =
		options.trigger ?? (options.sessionKey ? inferTrigger(options.sessionKey) : "unknown");

	return {
		agent_kind: inferAgentKind(options.agentId),
		agent_id: options.agentId,
		scope_id: scopeId,
		trigger,
		provider: options.providerId,
		model: options.modelId,
	};
}
```

注: `HEARTBEAT_SESSION_PREFIX` / `scopeKeyFromHeartbeatSessionKey` の import は不要になるので削除する。

- [ ] **Step 2: `nr test:spec` を実行し spec 通過確認**

Run: `nr test:spec -- spec/shared/namespace-parse-agent-id.spec.ts spec/observability/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/observability/src/agent-labels.ts
git commit -m "refactor(observability): inferAgentKind/inferScopeIdFromAgentId を parseAgentId 経由に統一"
```

## Task 4: `spec/agent/runner-llm-metrics.spec.ts` を厳格 agentId 形式に変更

**Files:**

- Modify: `spec/agent/runner-llm-metrics.spec.ts:63-132`

- [ ] **Step 1: テストの agentId / contextScopeId を整合させる**

L66-79 (テスト 1) を以下に置換:

- `agentId: "discord:111"` に変更
- `contextScopeId: "discord:guild:111"` (既存値)
- 期待値中の `agent_id="discord:guild-1"` → `agent_id="discord:111"`
- 期待値中の `scope_id="discord:guild:111"` (既存値)

L100-131 (テスト 2) を以下に置換:

- `agentId: "discord:heartbeat:111"` に変更
- `contextScopeId: "discord:guild:111"` (既存値)
- 期待値中の `agent_id="discord:heartbeat:guild-1"` → `agent_id="discord:heartbeat:111"`
- `agent_kind="discord_heartbeat"` (既存値)
- `scope_id="discord:guild:111"` (既存値)

- [ ] **Step 2: spec 実行して通過確認**

Run: `nr test:spec -- spec/agent/runner-llm-metrics.spec.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add spec/agent/runner-llm-metrics.spec.ts
git commit -m "test(agent): runner-llm-metrics spec の agentId を厳格モード規約に揃える"
```

## Task 5: observability agent-labels spec テストを追加

**Files:**

- Create: `spec/observability/agent-labels.spec.ts`

- [ ] **Step 1: spec テストを書く**

```typescript
import { describe, expect, test } from "bun:test";

import { buildAgentMetricLabels, inferAgentKind } from "@vicissitude/observability/agent-labels";

describe("inferAgentKind", () => {
	test("discord polling agentId", () => {
		expect(inferAgentKind("discord:111")).toBe("discord");
	});

	test("discord heartbeat agentId", () => {
		expect(inferAgentKind("discord:heartbeat:111")).toBe("discord_heartbeat");
	});

	test("緩い形式でも分類できる (strict モード非依存)", () => {
		expect(inferAgentKind("discord:guild-1")).toBe("discord");
		expect(inferAgentKind("discord:heartbeat:guild-1")).toBe("discord_heartbeat");
	});

	test("minecraft agentId", () => {
		expect(inferAgentKind("minecraft:brain")).toBe("minecraft");
	});

	test("web agentId", () => {
		expect(inferAgentKind("web:local")).toBe("web");
	});

	test("未知の agentId は unknown", () => {
		expect(inferAgentKind("foo:bar")).toBe("unknown");
		expect(inferAgentKind("")).toBe("unknown");
	});
});

describe("buildAgentMetricLabels", () => {
	test("parseAgentId 経由で scopeId を導出する", () => {
		const labels = buildAgentMetricLabels({
			agentId: "discord:111",
			providerId: "test-provider",
			modelId: "test-model",
		});
		expect(labels).toEqual({
			agent_kind: "discord",
			agent_id: "discord:111",
			scope_id: "discord:guild:111",
			trigger: "unknown",
			provider: "test-provider",
			model: "test-model",
		});
	});

	test("緩い agentId でも scopeId を導出できる", () => {
		const labels = buildAgentMetricLabels({
			agentId: "discord:guild-1",
			providerId: "test-provider",
			modelId: "test-model",
		});
		expect(labels.scope_id).toBe("discord:guild:guild-1");
		expect(labels.agent_kind).toBe("discord");
	});

	test("明示された scopeId を最優先する", () => {
		const labels = buildAgentMetricLabels({
			agentId: "discord:111",
			scopeId: "discord:guild:custom",
			providerId: "test-provider",
			modelId: "test-model",
		});
		expect(labels.scope_id).toBe("discord:guild:custom");
	});
});
```

- [ ] **Step 2: テスト実行して通過確認**

Run: `nr test:spec -- spec/observability/agent-labels.spec.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add spec/observability/agent-labels.spec.ts
git commit -m "test(observability): agent-labels spec テストを追加"
```

## Task 6: 全体検証

- [ ] **Step 1: format / lint / typecheck を一括実行**

Run: `nr validate`
Expected: 0 errors

- [ ] **Step 2: テスト全件実行**

Run: `nr test`
Expected: 全件 pass

- [ ] **Step 3: 変更確認**

```bash
git log --oneline -10
git diff main --stat
```

- [ ] **Step 4: push & PR 作成**

```bash
git push -u origin refactor/1083-parse-agent-id-unify
gh pr create --title "refactor(observability): inferAgentKind/inferScopeIdFromAgentId を parseAgentId 経由に統一 (#1083)" --body "Closes #1083"
```
