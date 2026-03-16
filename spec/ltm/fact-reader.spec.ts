import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { resolve } from "path";

import type { EmbeddingPort } from "../../packages/ltm/src/fact-reader.ts";
import { LtmFactReaderImpl } from "../../packages/ltm/src/fact-reader.ts";
import type { FactCategory } from "../../packages/ltm/src/types.ts";

const TEST_DATA_DIR = resolve(import.meta.dirname, "../../.test-fact-reader");
const GUILD_ID = "123456789";

function insertFact(db: Database, userId: string, category: FactCategory, fact: string): void {
	db.exec(`CREATE TABLE IF NOT EXISTS semantic_facts (
		id TEXT PRIMARY KEY, user_id TEXT NOT NULL, category TEXT NOT NULL, fact TEXT NOT NULL,
		keywords TEXT NOT NULL, source_episodic_ids TEXT NOT NULL, embedding TEXT NOT NULL,
		valid_at INTEGER NOT NULL, invalid_at INTEGER, created_at INTEGER NOT NULL)`);
	const now = Date.now();
	db.prepare(
		`INSERT INTO semantic_facts (id, user_id, category, fact, keywords, source_episodic_ids, embedding, valid_at, invalid_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		crypto.randomUUID(),
		userId,
		category,
		fact,
		JSON.stringify(["test"]),
		JSON.stringify(["ep1"]),
		JSON.stringify([0.1]),
		now,
		null,
		now,
	);
}

function createMockEmbedding(): EmbeddingPort {
	return { embed: mock(() => Promise.resolve([0.1])) };
}

beforeEach(() => {
	mkdirSync(resolve(TEST_DATA_DIR, "guilds", GUILD_ID), { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("LtmFactReaderImpl", () => {
	it("指定 guildId のファクトを返す", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const db = new Database(dbPath);
		insertFact(db, GUILD_ID, "preference", "コーヒーが好き");
		insertFact(db, GUILD_ID, "interest", "TypeScript が得意");
		db.close();

		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);
		const facts = await reader.getFacts(GUILD_ID);

		expect(facts).toHaveLength(2);
		expect(facts.some((f) => f.content === "コーヒーが好き" && f.category === "preference")).toBe(
			true,
		);
		expect(facts.some((f) => f.content === "TypeScript が得意" && f.category === "interest")).toBe(
			true,
		);
		await reader.close();
	});

	it("DB が存在しないギルドでは空配列を返す", async () => {
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);
		const facts = await reader.getFacts("999999");

		expect(facts).toEqual([]);
		await reader.close();
	});

	it("guildId なしでは空配列を返す", async () => {
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);
		const facts = await reader.getFacts();

		expect(facts).toEqual([]);
		await reader.close();
	});

	it("close() で接続が解放される", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const db = new Database(dbPath);
		insertFact(db, GUILD_ID, "identity", "テスト");
		db.close();

		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);
		await reader.getFacts(GUILD_ID);
		await reader.close();

		const reader2 = new LtmFactReaderImpl(TEST_DATA_DIR);
		const facts = await reader2.getFacts(GUILD_ID);
		expect(facts).toHaveLength(1);
		await reader2.close();
	});

	it("不正な guildId で例外をスローする", async () => {
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);

		expect(reader.getFacts("../malicious")).rejects.toThrow("Invalid guildId");
		await reader.close();
	});
});

describe("LtmFactReaderImpl.getRelevantFacts", () => {
	it("ファクト数が limit 以下なら全件返す（embedding 呼び出しなし）", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const db = new Database(dbPath);
		insertFact(db, GUILD_ID, "preference", "コーヒーが好き");
		insertFact(db, GUILD_ID, "interest", "TypeScript が得意");
		db.close();

		const embedding = createMockEmbedding();
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR, embedding);
		const facts = await reader.getRelevantFacts(GUILD_ID, "何かのコンテキスト", 10);

		expect(facts).toHaveLength(2);
		expect(embedding.embed).not.toHaveBeenCalled();
		await reader.close();
	});

	it("ファクト数が limit を超える場合に limit 件以内に絞られる", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const db = new Database(dbPath);
		for (let i = 0; i < 10; i++) {
			insertFact(db, GUILD_ID, "preference", `ファクト${i}`);
		}
		db.close();

		const embedding = createMockEmbedding();
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR, embedding);
		const facts = await reader.getRelevantFacts(GUILD_ID, "テストコンテキスト", 5);

		expect(facts.length).toBeLessThanOrEqual(5);
		expect(embedding.embed).toHaveBeenCalled();
		await reader.close();
	});

	it("context が空の場合は embedding なしでフォールバックする", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const db = new Database(dbPath);
		for (let i = 0; i < 10; i++) {
			insertFact(db, GUILD_ID, "preference", `ファクト${i}`);
		}
		db.close();

		const embedding = createMockEmbedding();
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR, embedding);
		const facts = await reader.getRelevantFacts(GUILD_ID, "", 5);

		expect(facts).toHaveLength(5);
		expect(embedding.embed).not.toHaveBeenCalled();
		await reader.close();
	});

	it("embedding がない場合は先頭 limit 件を返す", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const db = new Database(dbPath);
		for (let i = 0; i < 10; i++) {
			insertFact(db, GUILD_ID, "preference", `ファクト${i}`);
		}
		db.close();

		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);
		const facts = await reader.getRelevantFacts(GUILD_ID, "コンテキスト", 5);

		expect(facts).toHaveLength(5);
		await reader.close();
	});

	it("DB が存在しないギルドでは空配列を返す", async () => {
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);
		const facts = await reader.getRelevantFacts("999999", "コンテキスト", 10);

		expect(facts).toEqual([]);
		await reader.close();
	});

	it("不正な guildId で例外をスローする", async () => {
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR);

		expect(reader.getRelevantFacts("../malicious", "ctx", 10)).rejects.toThrow("Invalid guildId");
		await reader.close();
	});

	it("カテゴリ数が limit を超える場合でも limit 件以内に収まる", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const db = new Database(dbPath);
		const categories: FactCategory[] = [
			"identity",
			"preference",
			"interest",
			"personality",
			"relationship",
			"experience",
			"goal",
			"guideline",
		];
		for (const cat of categories) {
			insertFact(db, GUILD_ID, cat, `${cat}のファクト1`);
			insertFact(db, GUILD_ID, cat, `${cat}のファクト2`);
		}
		db.close();

		const embedding = createMockEmbedding();
		const reader = new LtmFactReaderImpl(TEST_DATA_DIR, embedding);
		// 8 カテゴリ × 2 件 = 16 件、limit = 5
		const facts = await reader.getRelevantFacts(GUILD_ID, "テスト", 5);

		expect(facts.length).toBeLessThanOrEqual(5);
		await reader.close();
	});
});
