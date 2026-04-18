import type { MemoryReadServices } from "@vicissitude/memory";
import type { MemoryNamespace } from "@vicissitude/memory/namespace";
import { namespaceKey } from "@vicissitude/memory/namespace";
import type { MemoryStorage } from "@vicissitude/memory/storage";

import { LruCache } from "./lru-cache.ts";

interface CacheEntry {
	instance: MemoryReadServices;
	storage: MemoryStorage;
}

export class MemoryInstanceCache {
	private readonly cache: LruCache<CacheEntry>;

	constructor(
		maxSize: number,
		private readonly factory: (namespace: MemoryNamespace) => {
			instance: MemoryReadServices;
			storage: MemoryStorage;
		},
	) {
		this.cache = new LruCache<CacheEntry>({
			maxSize,
			onEvict: (_key, entry) => entry.storage.close(),
		});
	}

	getOrCreate(namespace: MemoryNamespace): MemoryReadServices {
		const key = namespaceKey(namespace);

		const existing = this.cache.get(key);
		if (existing) return existing.instance;

		const { instance, storage } = this.factory(namespace);
		this.cache.set(key, { instance, storage });
		return instance;
	}

	getStorage(namespace: MemoryNamespace): MemoryStorage | undefined {
		return this.cache.peek(namespaceKey(namespace))?.storage;
	}

	closeAll(): void {
		this.cache.dispose();
	}
}
