export interface LruCacheOptions<T> {
	maxSize: number;
	ttlMs?: number;
	onEvict?: (key: string, value: T) => void;
}

interface CacheEntry<T> {
	value: T;
	createdAt: number;
}

export class LruCache<T> {
	private readonly entries = new Map<string, CacheEntry<T>>();
	private readonly maxSize: number;
	private readonly ttlMs: number | undefined;
	private readonly onEvict: ((key: string, value: T) => void) | undefined;

	constructor(options: LruCacheOptions<T>) {
		this.maxSize = options.maxSize;
		this.ttlMs = options.ttlMs;
		this.onEvict = options.onEvict;
	}

	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		if (this.ttlMs !== undefined && Date.now() - entry.createdAt >= this.ttlMs) {
			this.entries.delete(key);
			this.onEvict?.(key, entry.value);
			return undefined;
		}

		// LRU 更新: delete + re-insert で先頭に移動
		this.entries.delete(key);
		this.entries.set(key, entry);

		return entry.value;
	}

	/** LRU 順序を更新せずに値を取得する */
	peek(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		if (this.ttlMs !== undefined && Date.now() - entry.createdAt >= this.ttlMs) {
			this.entries.delete(key);
			this.onEvict?.(key, entry.value);
			return undefined;
		}

		return entry.value;
	}

	set(key: string, value: T): void {
		const existing = this.entries.get(key);
		if (existing) {
			this.entries.delete(key);
			this.onEvict?.(key, existing.value);
		}

		if (this.entries.size >= this.maxSize) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) {
				const oldest = this.entries.get(oldestKey)!;
				this.entries.delete(oldestKey);
				this.onEvict?.(oldestKey, oldest.value);
			}
		}

		this.entries.set(key, { value, createdAt: Date.now() });
	}

	get size(): number {
		return this.entries.size;
	}

	dispose(): void {
		if (this.onEvict) {
			for (const [key, entry] of this.entries) {
				this.onEvict(key, entry.value);
			}
		}
		this.entries.clear();
	}
}
