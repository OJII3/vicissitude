import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import { JsonSessionRepository } from "./json-session-repository.ts";

function createTempDir(): string {
	const dir = resolve(
		tmpdir(),
		`session-repo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	return dir;
}

describe("JsonSessionRepository", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true });
			}
		}
		tempDirs.length = 0;
	});

	function createRepo(): JsonSessionRepository {
		const dir = createTempDir();
		tempDirs.push(dir);
		return new JsonSessionRepository(dir);
	}

	it("save → get で値が取得できる", async () => {
		const repo = createRepo();

		await repo.save("agent-1", "key-1", "session-abc");
		expect(repo.get("agent-1", "key-1")).toBe("session-abc");
	});

	it("delete → get で undefined になる", async () => {
		const repo = createRepo();

		await repo.save("agent-1", "key-1", "session-abc");
		await repo.delete("agent-1", "key-1");
		expect(repo.get("agent-1", "key-1")).toBeUndefined();
	});

	it("存在しないキーに対する delete がエラーにならない", async () => {
		const repo = createRepo();

		await repo.delete("agent-1", "nonexistent");
		expect(repo.get("agent-1", "nonexistent")).toBeUndefined();
	});

	it("exists が正しく動作する", async () => {
		const repo = createRepo();

		expect(repo.exists("agent-1", "key-1")).toBe(false);

		await repo.save("agent-1", "key-1", "session-abc");
		expect(repo.exists("agent-1", "key-1")).toBe(true);

		await repo.delete("agent-1", "key-1");
		expect(repo.exists("agent-1", "key-1")).toBe(false);
	});

	it("count がメタキーを除外して正しく数える", async () => {
		const repo = createRepo();

		expect(repo.count()).toBe(0);

		await repo.save("agent-1", "key-1", "session-abc");
		expect(repo.count()).toBe(1);

		await repo.save("agent-1", "key-2", "session-def");
		expect(repo.count()).toBe(2);

		await repo.delete("agent-1", "key-1");
		expect(repo.count()).toBe(1);
	});

	it("save 時に createdAt が自動記録される", async () => {
		const repo = createRepo();
		const before = Date.now();

		await repo.save("agent-1", "key-1", "session-abc");

		const createdAt = repo.getCreatedAt("agent-1", "key-1");
		expect(createdAt).toBeDefined();
		expect(createdAt).toBeGreaterThanOrEqual(before);
		expect(createdAt).toBeLessThanOrEqual(Date.now());
	});

	it("save を再度呼んでも createdAt は上書きされない", async () => {
		const repo = createRepo();

		await repo.save("agent-1", "key-1", "session-abc");
		const firstCreatedAt = repo.getCreatedAt("agent-1", "key-1");

		await repo.save("agent-1", "key-1", "session-def");
		const secondCreatedAt = repo.getCreatedAt("agent-1", "key-1");

		expect(secondCreatedAt).toBe(firstCreatedAt);
		expect(repo.get("agent-1", "key-1")).toBe("session-def");
	});

	it("delete で createdAt も削除される", async () => {
		const repo = createRepo();

		await repo.save("agent-1", "key-1", "session-abc");
		expect(repo.getCreatedAt("agent-1", "key-1")).toBeDefined();

		await repo.delete("agent-1", "key-1");
		expect(repo.getCreatedAt("agent-1", "key-1")).toBeUndefined();
	});

	it("ファイル永続化: save 後に新しいインスタンスで get できる", async () => {
		const dir = createTempDir();
		tempDirs.push(dir);

		const repo1 = new JsonSessionRepository(dir);
		await repo1.save("agent-1", "key-1", "session-abc");

		const repo2 = new JsonSessionRepository(dir);
		expect(repo2.get("agent-1", "key-1")).toBe("session-abc");
	});

	it("ファイル永続化: delete 後に新しいインスタンスで get が undefined", async () => {
		const dir = createTempDir();
		tempDirs.push(dir);

		const repo1 = new JsonSessionRepository(dir);
		await repo1.save("agent-1", "key-1", "session-abc");
		await repo1.delete("agent-1", "key-1");

		const repo2 = new JsonSessionRepository(dir);
		expect(repo2.get("agent-1", "key-1")).toBeUndefined();
		expect(repo2.getCreatedAt("agent-1", "key-1")).toBeUndefined();
	});

	it("ファイル永続化: createdAt が再読み込み後も保持される", async () => {
		const dir = createTempDir();
		tempDirs.push(dir);

		const repo1 = new JsonSessionRepository(dir);
		await repo1.save("agent-1", "key-1", "session-abc");
		const createdAt = repo1.getCreatedAt("agent-1", "key-1");

		const repo2 = new JsonSessionRepository(dir);
		expect(repo2.getCreatedAt("agent-1", "key-1")).toBe(createdAt);
	});
});
