import type { MemoryReadServices } from "@vicissitude/memory";
import type { MemoryNamespace } from "@vicissitude/memory/namespace";
import { namespaceKey } from "@vicissitude/memory/namespace";
import type { MemoryStorage } from "@vicissitude/memory/storage";

export class MemoryInstanceCache {
	private readonly instances = new Map<string, MemoryReadServices>();
	private readonly storages = new Map<string, MemoryStorage>();

	constructor(
		private readonly maxSize: number,
		private readonly factory: (namespace: MemoryNamespace) => {
			instance: MemoryReadServices;
			storage: MemoryStorage;
		},
	) {}

	getOrCreate(namespace: MemoryNamespace): MemoryReadServices {
		const key = namespaceKey(namespace);

		const existing = this.instances.get(key);
		if (existing) {
			// LRU: 再挿入して最新アクセスとして記録
			this.instances.delete(key);
			this.instances.set(key, existing);
			return existing;
		}

		// Evict oldest entry if at capacity
		if (this.instances.size >= this.maxSize) {
			const oldestKey = this.instances.keys().next().value as string;
			this.instances.delete(oldestKey);
			const oldStorage = this.storages.get(oldestKey);
			oldStorage?.close();
			this.storages.delete(oldestKey);
		}

		const { instance, storage } = this.factory(namespace);
		this.instances.set(key, instance);
		this.storages.set(key, storage);
		return instance;
	}

	/** 特定の namespace の MemoryStorage を取得（ListeningMemory 用） */
	getStorage(namespace: MemoryNamespace): MemoryStorage | undefined {
		return this.storages.get(namespaceKey(namespace));
	}

	/** 全リソースを解放 */
	closeAll(): void {
		for (const storage of this.storages.values()) {
			storage.close();
		}
		this.instances.clear();
		this.storages.clear();
	}
}
