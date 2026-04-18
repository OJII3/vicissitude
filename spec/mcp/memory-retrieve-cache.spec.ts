/**
 * Issue #615: memory_retrieve に TTL キャッシュ
 *
 * 期待仕様:
 * 1. 同一クエリ・同一 namespace に対して TTL 内の2回目呼び出しはキャッシュから返す
 * 2. 異なるクエリ or 異なる namespace はキャッシュヒットしない
 * 3. TTL 経過後はキャッシュから evict され、再検索が行われる
 * 4. キャッシュサイズが上限（100エントリ）を超えると LRU eviction が行われる
 * 5. limit が異なる同一クエリは別キャッシュエントリとして扱う
 * 6. キャッシュキー: namespace + query + limit
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { MemoryRetrieveCache } from "@vicissitude/mcp/memory-retrieve-cache";

// ─── テストヘルパー ──────────────────────────────────────────────

interface CacheEntry {
	text: string;
}

function makeKey(ns: string, query: string, limit: number): string {
	return `${ns}:${query}:${limit}`;
}

describe("MemoryRetrieveCache", () => {
	let cache: MemoryRetrieveCache<CacheEntry>;

	beforeEach(() => {
		// 30分 TTL
		cache = new MemoryRetrieveCache<CacheEntry>({
			ttlMs: 30 * 60 * 1000,
			maxSize: 100,
		});
	});

	afterEach(() => {
		cache.dispose();
	});

	// ─── 基本的なキャッシュ動作 ──────────────────────────────────

	describe("基本的なキャッシュ動作", () => {
		it("set したエントリが get で取得できる", () => {
			const key = makeKey("discord-guild:123", "hello", 10);
			const value = { text: "cached result" };

			cache.set(key, value);

			expect(cache.get(key)).toBe(value);
		});

		it("未設定のキーは undefined を返す", () => {
			expect(cache.get("nonexistent")).toBeUndefined();
		});

		it("異なるキーは別エントリとして扱われる", () => {
			const key1 = makeKey("discord-guild:123", "hello", 10);
			const key2 = makeKey("discord-guild:123", "world", 10);
			const value1 = { text: "result 1" };
			const value2 = { text: "result 2" };

			cache.set(key1, value1);
			cache.set(key2, value2);

			expect(cache.get(key1)).toBe(value1);
			expect(cache.get(key2)).toBe(value2);
		});

		it("同一 query でも limit が異なれば別エントリ", () => {
			const key10 = makeKey("discord-guild:123", "hello", 10);
			const key20 = makeKey("discord-guild:123", "hello", 20);
			const value10 = { text: "limit 10" };
			const value20 = { text: "limit 20" };

			cache.set(key10, value10);
			cache.set(key20, value20);

			expect(cache.get(key10)).toBe(value10);
			expect(cache.get(key20)).toBe(value20);
		});

		it("同一 query でも namespace が異なれば別エントリ", () => {
			const key1 = makeKey("discord-guild:111", "hello", 10);
			const key2 = makeKey("discord-guild:222", "hello", 10);
			const value1 = { text: "guild 111" };
			const value2 = { text: "guild 222" };

			cache.set(key1, value1);
			cache.set(key2, value2);

			expect(cache.get(key1)).toBe(value1);
			expect(cache.get(key2)).toBe(value2);
		});
	});

	// ─── TTL ────────────────────────────────────────────────────

	describe("TTL による自動 eviction", () => {
		it("TTL 経過後はキャッシュから evict される", () => {
			// 50ms TTL
			const shortTtlCache = new MemoryRetrieveCache<CacheEntry>({
				ttlMs: 50,
				maxSize: 100,
			});

			const key = makeKey("discord-guild:123", "hello", 10);
			shortTtlCache.set(key, { text: "cached" });

			expect(shortTtlCache.get(key)).toBeDefined();

			// TTL 経過をシミュレート（内部タイムスタンプの比較）
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					expect(shortTtlCache.get(key)).toBeUndefined();
					shortTtlCache.dispose();
					resolve();
				}, 100);
			});
		});

		it("TTL 内であればキャッシュが有効", () => {
			const key = makeKey("discord-guild:123", "hello", 10);
			const value = { text: "cached" };

			cache.set(key, value);

			// TTL (30分) 内なので即座に取得できる
			expect(cache.get(key)).toBe(value);
		});
	});

	// ─── LRU eviction ────────────────────────────────────────────

	describe("LRU eviction", () => {
		it("maxSize を超えると最も古いエントリが evict される", () => {
			const smallCache = new MemoryRetrieveCache<CacheEntry>({
				ttlMs: 30 * 60 * 1000,
				maxSize: 3,
			});

			smallCache.set("key-1", { text: "1" });
			smallCache.set("key-2", { text: "2" });
			smallCache.set("key-3", { text: "3" });
			// key-1 が最も古い → evict 対象
			smallCache.set("key-4", { text: "4" });

			expect(smallCache.get("key-1")).toBeUndefined();
			expect(smallCache.get("key-2")).toBeDefined();
			expect(smallCache.get("key-3")).toBeDefined();
			expect(smallCache.get("key-4")).toBeDefined();

			smallCache.dispose();
		});

		it("get でアクセスされたエントリは LRU の先頭に移動する", () => {
			const smallCache = new MemoryRetrieveCache<CacheEntry>({
				ttlMs: 30 * 60 * 1000,
				maxSize: 3,
			});

			smallCache.set("key-1", { text: "1" });
			smallCache.set("key-2", { text: "2" });
			smallCache.set("key-3", { text: "3" });

			// key-1 をアクセスして最新にする
			smallCache.get("key-1");

			// key-4 追加 → key-2 が evict されるべき（key-1 は最近アクセスされた）
			smallCache.set("key-4", { text: "4" });

			expect(smallCache.get("key-1")).toBeDefined();
			expect(smallCache.get("key-2")).toBeUndefined();
			expect(smallCache.get("key-3")).toBeDefined();
			expect(smallCache.get("key-4")).toBeDefined();

			smallCache.dispose();
		});
	});

	// ─── dispose ─────────────────────────────────────────────────

	describe("dispose", () => {
		it("dispose 後はすべてのエントリが取得できなくなる", () => {
			cache.set("key-1", { text: "1" });
			cache.set("key-2", { text: "2" });

			cache.dispose();

			expect(cache.get("key-1")).toBeUndefined();
			expect(cache.get("key-2")).toBeUndefined();
		});
	});

	// ─── size ────────────────────────────────────────────────────

	describe("size", () => {
		it("エントリ数を返す", () => {
			expect(cache.size).toBe(0);

			cache.set("key-1", { text: "1" });
			expect(cache.size).toBe(1);

			cache.set("key-2", { text: "2" });
			expect(cache.size).toBe(2);
		});

		it("同一キーに上書きしてもサイズは増えない", () => {
			cache.set("key-1", { text: "1" });
			cache.set("key-1", { text: "updated" });

			expect(cache.size).toBe(1);
		});
	});
});
