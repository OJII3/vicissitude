/**
 * Issue #615: OpencodeSessionPort に summarizeSession() を追加
 *
 * 期待仕様:
 * 1. OpencodeSessionPort に summarizeSession(sessionId: string): Promise<void> が存在する
 * 2. OpencodeSessionAdapter.summarizeSession は oc.session.summarize({ sessionID }) を呼ぶ
 * 3. SDK がエラーを返した場合は例外をスローする
 * 4. summarizeSession は非同期で compaction を開始するだけ（完了は session.compacted イベントで検知）
 */
import { describe, expect, mock, test } from "bun:test";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import type { OpencodeSessionPort } from "@vicissitude/shared/types";

// ─── 型レベルテスト ──────────────────────────────────────────────

describe("OpencodeSessionPort 型", () => {
	test("summarizeSession(sessionId: string): Promise<void> が存在する", () => {
		// コンパイルが通ること自体が型レベルの検証（ランタイム assertion なし）
		type HasSummarize = OpencodeSessionPort["summarizeSession"];
		type _Assert = HasSummarize extends (sessionId: string) => Promise<void> ? true : never;
		expect(true).toBe(true);
	});
});

// ─── テストヘルパー ──────────────────────────────────────────────

function createClient(summarizeResult?: { error?: unknown; data?: unknown }) {
	const client = {
		event: {
			subscribe: mock(() => Promise.resolve({ stream: (async function* () {})() })),
		},
		session: {
			create: mock(() => Promise.resolve({ data: { id: "session-1" }, error: null })),
			get: mock(() => Promise.resolve({ data: null, error: { message: "missing" } })),
			prompt: mock(() => Promise.resolve({ data: { parts: [], info: {} }, error: null })),
			promptAsync: mock(() => Promise.resolve({ data: {}, error: null })),
			abort: mock(() => Promise.resolve({ data: {}, error: null })),
			delete: mock(() => Promise.resolve({ data: {}, error: null })),
			summarize: mock(() => Promise.resolve(summarizeResult ?? { data: {}, error: null })),
		},
	};
	return client as unknown as OpencodeClient;
}

function createAdapter(client: OpencodeClient): OpencodeSessionAdapter {
	return new OpencodeSessionAdapter({
		port: 4096,
		mcpServers: {},
		builtinTools: {},
		clientFactory: mock(() =>
			Promise.resolve({
				client,
				server: { url: "http://localhost", close: mock(() => {}) },
			}),
		),
	});
}

// ─── 振る舞いテスト ──────────────────────────────────────────────

describe("OpencodeSessionAdapter.summarizeSession", () => {
	test("oc.session.summarize を sessionID 付きで呼び出す", async () => {
		const client = createClient();
		const adapter = createAdapter(client);

		await adapter.summarizeSession("session-abc");

		expect(client.session.summarize).toHaveBeenCalledTimes(1);
		expect(client.session.summarize).toHaveBeenCalledWith({
			sessionID: "session-abc",
		});
	});

	test("正常時は void を返す（値なし）", async () => {
		const client = createClient();
		const adapter = createAdapter(client);

		const result = await adapter.summarizeSession("session-abc");

		expect(result).toBeUndefined();
	});

	test("SDK がエラーを返した場合は例外をスローする", async () => {
		const client = createClient({
			error: { message: "session not found" },
			data: null,
		});
		const adapter = createAdapter(client);

		// oxlint-disable-next-line await-thenable -- Bun の expect().rejects.toThrow() は実行時 Promise
		await expect(adapter.summarizeSession("session-xyz")).rejects.toThrow();
	});
});
