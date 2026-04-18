export interface MemoryRetrieveCacheOptions {
	ttlMs: number;
	maxSize: number;
}

interface CacheEntry<T> {
	value: T;
	createdAt: number;
}

export class MemoryRetrieveCache<T> {
	private readonly entries = new Map<string, CacheEntry<T>>();
	private readonly ttlMs: number;
	private readonly maxSize: number;

	constructor(options: MemoryRetrieveCacheOptions) {
		this.ttlMs = options.ttlMs;
		this.maxSize = options.maxSize;
	}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		// TTL チェック — 期限切れなら lazy evict
		if (Date.now() - entry.createdAt >= this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}

		// LRU 更新: delete + re-insert で先頭に移動
		this.entries.delete(key);
		this.entries.set(key, entry);

		return entry.value;
	}

	set(key: string, value: T): void {
		// 既存エントリの上書き時はまず削除（LRU 位置をリセット）
		this.entries.delete(key);

		// maxSize 超過時は最古（Map の最初）を evict
		if (this.entries.size >= this.maxSize) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) {
				this.entries.delete(oldestKey);
			}
		}

		this.entries.set(key, { value, createdAt: Date.now() });
	}

	get size(): number {
		return this.entries.size;
	}

	dispose(): void {
		this.entries.clear();
	}
}
