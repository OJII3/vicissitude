import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import { JsonEmojiUsageRepository } from "./json-emoji-usage-repository.ts";

function createTempDir(): string {
	const dir = resolve(
		tmpdir(),
		`emoji-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	return dir;
}

describe("JsonEmojiUsageRepository", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true });
			}
		}
		tempDirs.length = 0;
	});

	function createRepo(): JsonEmojiUsageRepository {
		const dir = createTempDir();
		tempDirs.push(dir);
		return new JsonEmojiUsageRepository(dir);
	}

	it("increment でカウントが増える", () => {
		const repo = createRepo();

		repo.increment("guild-1", "pepe_sad");
		repo.increment("guild-1", "pepe_sad");
		repo.increment("guild-1", "fire");

		const top = repo.getTopEmojis("guild-1", 10);
		expect(top).toEqual([
			{ emojiName: "pepe_sad", count: 2 },
			{ emojiName: "fire", count: 1 },
		]);
	});

	it("getTopEmojis は降順で limit 件返す", () => {
		const repo = createRepo();

		repo.increment("guild-1", "a");
		repo.increment("guild-1", "b");
		repo.increment("guild-1", "b");
		repo.increment("guild-1", "c");
		repo.increment("guild-1", "c");
		repo.increment("guild-1", "c");

		const top = repo.getTopEmojis("guild-1", 2);
		expect(top).toEqual([
			{ emojiName: "c", count: 3 },
			{ emojiName: "b", count: 2 },
		]);
	});

	it("存在しない guild は空配列を返す", () => {
		const repo = createRepo();

		expect(repo.getTopEmojis("unknown", 10)).toEqual([]);
	});

	it("hasData はデータの存在を正しく返す", () => {
		const repo = createRepo();

		expect(repo.hasData("guild-1")).toBe(false);

		repo.increment("guild-1", "pepe_sad");
		expect(repo.hasData("guild-1")).toBe(true);
		expect(repo.hasData("guild-2")).toBe(false);
	});

	it("guild ごとにデータが分離される", () => {
		const repo = createRepo();

		repo.increment("guild-1", "pepe_sad");
		repo.increment("guild-2", "fire");

		expect(repo.getTopEmojis("guild-1", 10)).toEqual([{ emojiName: "pepe_sad", count: 1 }]);
		expect(repo.getTopEmojis("guild-2", 10)).toEqual([{ emojiName: "fire", count: 1 }]);
	});

	it("flush でファイルに書き出され、再読み込みできる", async () => {
		const dir = createTempDir();
		tempDirs.push(dir);

		const repo1 = new JsonEmojiUsageRepository(dir);
		repo1.increment("guild-1", "pepe_sad");
		repo1.increment("guild-1", "pepe_sad");
		await repo1.flush();

		const repo2 = new JsonEmojiUsageRepository(dir);
		expect(repo2.getTopEmojis("guild-1", 10)).toEqual([{ emojiName: "pepe_sad", count: 2 }]);
	});
});
