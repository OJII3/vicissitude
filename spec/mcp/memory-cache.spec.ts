import { describe, expect, it, mock } from "bun:test";

import { MemoryInstanceCache } from "@vicissitude/mcp/memory-cache";
import type { MemoryReadServices } from "@vicissitude/memory";
import type { MemoryNamespace } from "@vicissitude/memory/namespace";
import type { MemoryStorage } from "@vicissitude/memory/storage";

function makeNamespace(guildId: string): MemoryNamespace {
	return { surface: "discord-guild", guildId };
}

function makeFactory() {
	const closeCalls: string[] = [];

	const factory = (namespace: MemoryNamespace) => {
		const instance = {} as MemoryReadServices;
		const storage = {
			close: mock(() => {
				const key = namespace.surface === "discord-guild" ? namespace.guildId : "internal";
				closeCalls.push(key);
			}),
		} as unknown as MemoryStorage;
		return { instance, storage };
	};

	return { factory, closeCalls };
}

describe("MemoryInstanceCache", () => {
	it("getOrCreate は同じ namespace に対して同一インスタンスを返す", () => {
		const { factory } = makeFactory();
		const cache = new MemoryInstanceCache(3, factory);
		const ns = makeNamespace("guild-1");

		const a = cache.getOrCreate(ns);
		const b = cache.getOrCreate(ns);

		expect(a).toBe(b);
	});

	it("異なる namespace に対して異なるインスタンスを返す", () => {
		const { factory } = makeFactory();
		const cache = new MemoryInstanceCache(3, factory);

		const a = cache.getOrCreate(makeNamespace("guild-1"));
		const b = cache.getOrCreate(makeNamespace("guild-2"));

		expect(a).not.toBe(b);
	});

	it("maxSize を超えると最も古いエントリが evict される", () => {
		const { factory, closeCalls } = makeFactory();
		const cache = new MemoryInstanceCache(2, factory);

		cache.getOrCreate(makeNamespace("guild-1"));
		cache.getOrCreate(makeNamespace("guild-2"));
		cache.getOrCreate(makeNamespace("guild-3"));

		expect(closeCalls).toEqual(["guild-1"]);
	});

	it("LRU: アクセスされたエントリは evict 対象から外れる", () => {
		const { factory, closeCalls } = makeFactory();
		const cache = new MemoryInstanceCache(2, factory);

		cache.getOrCreate(makeNamespace("guild-1"));
		cache.getOrCreate(makeNamespace("guild-2"));

		// guild-1 を再アクセスして最新にする
		cache.getOrCreate(makeNamespace("guild-1"));

		// guild-3 追加 → guild-2 が evict されるべき
		cache.getOrCreate(makeNamespace("guild-3"));

		expect(closeCalls).toEqual(["guild-2"]);
	});

	it("getStorage は getOrCreate で作成された storage を返す", () => {
		const { factory } = makeFactory();
		const cache = new MemoryInstanceCache(3, factory);
		const ns = makeNamespace("guild-1");

		cache.getOrCreate(ns);
		const storage = cache.getStorage(ns);

		expect(storage).toBeDefined();
	});

	it("getStorage は未作成の namespace に対して undefined を返す", () => {
		const { factory } = makeFactory();
		const cache = new MemoryInstanceCache(3, factory);

		const storage = cache.getStorage(makeNamespace("unknown"));

		expect(storage).toBeUndefined();
	});

	it("evict されたエントリの storage は getStorage で取得できない", () => {
		const { factory } = makeFactory();
		const cache = new MemoryInstanceCache(1, factory);

		cache.getOrCreate(makeNamespace("guild-1"));
		cache.getOrCreate(makeNamespace("guild-2"));

		expect(cache.getStorage(makeNamespace("guild-1"))).toBeUndefined();
		expect(cache.getStorage(makeNamespace("guild-2"))).toBeDefined();
	});

	it("closeAll は全ての storage を close し、キャッシュを空にする", () => {
		const { factory, closeCalls } = makeFactory();
		const cache = new MemoryInstanceCache(3, factory);

		cache.getOrCreate(makeNamespace("guild-1"));
		cache.getOrCreate(makeNamespace("guild-2"));

		cache.closeAll();

		expect(closeCalls).toContain("guild-1");
		expect(closeCalls).toContain("guild-2");
		expect(cache.getStorage(makeNamespace("guild-1"))).toBeUndefined();
		expect(cache.getStorage(makeNamespace("guild-2"))).toBeUndefined();
	});

	it("closeAll 後に getOrCreate すると新しいインスタンスが作られる", () => {
		const { factory } = makeFactory();
		const cache = new MemoryInstanceCache(3, factory);
		const ns = makeNamespace("guild-1");

		const before = cache.getOrCreate(ns);
		cache.closeAll();
		const after = cache.getOrCreate(ns);

		expect(before).not.toBe(after);
	});
});
