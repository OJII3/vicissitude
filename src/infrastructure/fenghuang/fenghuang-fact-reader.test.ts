import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { resolve } from "path";

import { SQLiteStorageAdapter, createFact } from "fenghuang";
import type { FactCategory } from "fenghuang";

import { FenghuangFactReader } from "./fenghuang-fact-reader.ts";

const TEST_DATA_DIR = resolve(import.meta.dirname, "../../../.test-fact-reader");
const GUILD_ID = "123456789";

async function insertFact(
	storage: SQLiteStorageAdapter,
	userId: string,
	category: FactCategory,
	fact: string,
): Promise<void> {
	const f = createFact({
		userId,
		category,
		fact,
		keywords: ["test"],
		sourceEpisodicIds: ["ep1"],
		embedding: [0.1],
	});
	await storage.saveFact(userId, f);
}

beforeEach(() => {
	mkdirSync(resolve(TEST_DATA_DIR, "guilds", GUILD_ID), { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("FenghuangFactReader", () => {
	it("指定 guildId のファクトを返す", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const storage = new SQLiteStorageAdapter(dbPath);
		await insertFact(storage, GUILD_ID, "preference", "コーヒーが好き");
		await insertFact(storage, GUILD_ID, "interest", "TypeScript が得意");
		storage.close();

		const reader = new FenghuangFactReader(TEST_DATA_DIR);
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
		const reader = new FenghuangFactReader(TEST_DATA_DIR);
		const facts = await reader.getFacts("999999");

		expect(facts).toEqual([]);
		await reader.close();
	});

	it("guildId なしでは空配列を返す", async () => {
		const reader = new FenghuangFactReader(TEST_DATA_DIR);
		const facts = await reader.getFacts();

		expect(facts).toEqual([]);
		await reader.close();
	});

	it("close() で接続が解放される", async () => {
		const dbPath = resolve(TEST_DATA_DIR, "guilds", GUILD_ID, "memory.db");
		const storage = new SQLiteStorageAdapter(dbPath);
		await insertFact(storage, GUILD_ID, "identity", "テスト");
		storage.close();

		const reader = new FenghuangFactReader(TEST_DATA_DIR);
		await reader.getFacts(GUILD_ID);
		await reader.close();

		// close 後に新しいインスタンスが問題なく開けることを確認
		const reader2 = new FenghuangFactReader(TEST_DATA_DIR);
		const facts = await reader2.getFacts(GUILD_ID);
		expect(facts).toHaveLength(1);
		await reader2.close();
	});

	it("不正な guildId で例外をスローする", async () => {
		const reader = new FenghuangFactReader(TEST_DATA_DIR);

		expect(reader.getFacts("../malicious")).rejects.toThrow("Invalid guildId");
		await reader.close();
	});
});
