import { describe, expect, it } from "bun:test";

import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import type { MemoryStorage } from "@vicissitude/memory/storage";
import { HUA_SELF_SUBJECT } from "@vicissitude/shared/namespace";
import type { SpotifyTrack } from "@vicissitude/spotify/types";

import { ListeningMemory } from "./listening-memory.ts";
import type { Embedder } from "./listening-memory.ts";
import type { ListeningRecord } from "./types.ts";

// --- stubs / fixtures ---

interface StubStorage {
	storage: MemoryStorage;
	saved: Array<{ userId: string; fact: SemanticFact }>;
}

function createStubStorage(): StubStorage {
	const saved: Array<{ userId: string; fact: SemanticFact }> = [];
	const stub = {
		saveFact(userId: string, fact: SemanticFact): Promise<void> {
			saved.push({ userId, fact });
			return Promise.resolve();
		},
	} as unknown as MemoryStorage;
	return { storage: stub, saved };
}

interface SpyEmbedder extends Embedder {
	calls: string[];
}

function createSpyEmbedder(embedding: number[] = [0.1, 0.2, 0.3]): SpyEmbedder {
	const calls: string[] = [];
	return {
		calls,
		embed(text: string): Promise<number[]> {
			calls.push(text);
			return Promise.resolve(embedding);
		},
	};
}

function makeTrack(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
	return {
		id: overrides.id ?? "t-1",
		name: overrides.name ?? "夜に駆ける",
		artistName: overrides.artistName ?? "YOASOBI",
		artistId: overrides.artistId ?? "a-1",
		albumName: overrides.albumName ?? "THE BOOK",
		genres: overrides.genres ?? ["j-pop"],
		popularity: overrides.popularity ?? 85,
		releaseDate: overrides.releaseDate ?? "2020-12-15",
		albumArtUrl: overrides.albumArtUrl ?? "https://example.com/art.jpg",
	};
}

function makeRecord(overrides: Partial<ListeningRecord> = {}): ListeningRecord {
	return {
		track: overrides.track ?? makeTrack(),
		impression: overrides.impression ?? "歌詞が切なくて好き",
		listenedAt: overrides.listenedAt ?? new Date("2026-04-06T12:00:00Z"),
	};
}

// --- tests ---

describe("ListeningMemory.saveListening — fact 本文の組み立て", () => {
	it("fact 本文は `${artistName} の『${name}』を聴いた。${impression}` の形式", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(
			makeRecord({
				track: makeTrack({ name: "群青", artistName: "YOASOBI" }),
				impression: "爽やかで好き",
			}),
		);

		expect(saved[0]?.fact.fact).toBe("YOASOBI の『群青』を聴いた。爽やかで好き");
	});

	it("impression が空文字でも fact 本文は組み立てられる", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(
			makeRecord({
				track: makeTrack({ name: "X", artistName: "Y" }),
				impression: "",
			}),
		);

		expect(saved[0]?.fact.fact).toBe("Y の『X』を聴いた。");
	});
});

describe("ListeningMemory.saveListening — keywords", () => {
	it("keywords は [track.name, track.artistName] の順で格納される", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(
			makeRecord({ track: makeTrack({ name: "曲名", artistName: "アーティスト名" }) }),
		);

		expect(saved[0]?.fact.keywords).toEqual(["曲名", "アーティスト名"]);
	});

	it("name と artistName が同値でも重複除去は行わない（そのまま配列化）", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(
			makeRecord({ track: makeTrack({ name: "Same", artistName: "Same" }) }),
		);

		expect(saved[0]?.fact.keywords).toEqual(["Same", "Same"]);
	});
});

describe("ListeningMemory.saveListening — embedder 呼び出し", () => {
	it("embedder.embed は fact 本文と同じ文字列で 1 回呼ばれる", async () => {
		const { storage } = createStubStorage();
		const embedder = createSpyEmbedder();
		const memory = new ListeningMemory(storage, embedder);

		await memory.saveListening(
			makeRecord({
				track: makeTrack({ name: "群青", artistName: "YOASOBI" }),
				impression: "爽やか",
			}),
		);

		expect(embedder.calls).toHaveLength(1);
		expect(embedder.calls[0]).toBe("YOASOBI の『群青』を聴いた。爽やか");
	});

	it("embedder から返った vector が SemanticFact.embedding に格納される", async () => {
		const { storage, saved } = createStubStorage();
		const custom = [0.9, 0.8, 0.7, 0.6];
		const memory = new ListeningMemory(storage, createSpyEmbedder(custom));

		await memory.saveListening(makeRecord());

		expect(saved[0]?.fact.embedding).toEqual(custom);
	});
});

describe("ListeningMemory.saveListening — 固定値", () => {
	it("userId は HUA_SELF_SUBJECT", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(makeRecord());

		expect(saved[0]?.fact.userId).toBe(HUA_SELF_SUBJECT);
		expect(saved[0]?.userId).toBe(HUA_SELF_SUBJECT);
	});

	it("category は 'experience' 固定", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(makeRecord());

		expect(saved[0]?.fact.category).toBe("experience");
	});

	it("sourceEpisodicIds は空配列", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(makeRecord());

		expect(saved[0]?.fact.sourceEpisodicIds).toEqual([]);
	});

	it("invalidAt は null", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(makeRecord());

		expect(saved[0]?.fact.invalidAt).toBeNull();
	});

	it("id は crypto.randomUUID() による UUID 形式", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(makeRecord());

		// UUID v4 形式: 8-4-4-4-12 hex
		expect(saved[0]?.fact.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
	});

	it("複数回呼ぶと id はそれぞれユニーク", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(makeRecord());
		await memory.saveListening(makeRecord());

		expect(saved[0]?.fact.id).not.toBe(saved[1]?.fact.id);
	});
});

describe("ListeningMemory.saveListening — 時刻", () => {
	it("validAt / createdAt は record.listenedAt と同値", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());
		const listenedAt = new Date("2025-11-23T09:30:00Z");

		await memory.saveListening(makeRecord({ listenedAt }));

		expect(saved[0]?.fact.validAt.getTime()).toBe(listenedAt.getTime());
		expect(saved[0]?.fact.createdAt.getTime()).toBe(listenedAt.getTime());
	});
});

describe("ListeningMemory.saveListening — 戻り値", () => {
	it("保存した SemanticFact をそのまま返す", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		const returned = await memory.saveListening(makeRecord());

		expect(returned).toBe(saved[0]?.fact as SemanticFact);
	});
});

describe("ListeningMemory.saveListening — storage.saveFact への引数", () => {
	it("saveFact は userId=HUA_SELF_SUBJECT と fact を引数に呼ばれる", async () => {
		const { storage, saved } = createStubStorage();
		const memory = new ListeningMemory(storage, createSpyEmbedder());

		await memory.saveListening(makeRecord());

		expect(saved).toHaveLength(1);
		expect(saved[0]?.userId).toBe(HUA_SELF_SUBJECT);
	});
});
