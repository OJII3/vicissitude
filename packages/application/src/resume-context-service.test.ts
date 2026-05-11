import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	defaultSubject,
	discordGuildNamespace,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
} from "@vicissitude/memory/namespace";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import { MemoryStorage } from "@vicissitude/memory/storage";

import { ResumeContextService } from "./resume-context-service.ts";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createTempRoot(): string {
	const root: string = join(tmpdir(), `vicissitude-resume-context-${crypto.randomUUID()}`);
	mkdirSync(root, { recursive: true });
	tempRoots.push(root);
	return root;
}

function createFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
	const now = new Date("2026-01-03T00:00:00Z");
	return {
		id: overrides.id ?? crypto.randomUUID(),
		userId: overrides.userId ?? "123456789012345678",
		category: overrides.category ?? "preference",
		fact: overrides.fact ?? "TypeScript が好き",
		keywords: overrides.keywords ?? [],
		sourceEpisodicIds: overrides.sourceEpisodicIds ?? [],
		embedding: overrides.embedding ?? [0.1, 0.2, 0.3],
		validAt: overrides.validAt ?? now,
		invalidAt: overrides.invalidAt ?? null,
		createdAt: overrides.createdAt ?? now,
		metadata: overrides.metadata ?? {},
	};
}

describe("ResumeContextService", () => {
	test("memory DB から RESUME-CONTEXT.md を生成する", async () => {
		const root = createTempRoot();
		const memoryDataDir: string = join(root, "memory");
		const overlayDir: string = join(root, "context");
		const guildId = "123456789012345678";
		const namespace = discordGuildNamespace(guildId);
		const userId = defaultSubject(namespace);
		const dbDir = resolveMemoryDbDir(memoryDataDir, namespace);
		mkdirSync(dbDir, { recursive: true });

		const storage = new MemoryStorage(resolveMemoryDbPath(memoryDataDir, namespace));
		await storage.saveFact(
			userId,
			createFact({
				userId,
				category: "goal",
				fact: "再開時に過去の文脈を思い出す",
				createdAt: new Date("2026-01-04T00:00:00Z"),
			}),
		);
		await storage.saveFact(
			userId,
			createFact({
				userId,
				category: "preference",
				fact: "短い要約を好む",
				createdAt: new Date("2026-01-02T00:00:00Z"),
			}),
		);
		await storage.saveEpisode(userId, {
			id: "episode-1",
			userId,
			title: "再開コンテキストの相談",
			summary: "デプロイし直したあとも文脈を失わないように、直近の記憶を要約して渡す話をした。",
			messages: [{ role: "user", content: "再開コンテキストがほしい" }],
			embedding: [0.1, 0.2, 0.3],
			surprise: 0.5,
			stability: 1,
			difficulty: 0.3,
			startAt: new Date("2026-01-02T11:00:00Z"),
			endAt: new Date("2026-01-02T12:00:00Z"),
			createdAt: new Date("2026-01-02T12:00:00Z"),
			lastReviewedAt: null,
			consolidatedAt: null,
		});
		storage.close();

		const service = new ResumeContextService({
			memoryDataDir,
			overlayDir,
			lookbackMs: Number.MAX_SAFE_INTEGER,
		});
		await service.updateGuild(guildId);
		service.close();

		const content = readFileSync(join(overlayDir, "guilds", guildId, "RESUME-CONTEXT.md"), "utf8");
		expect(content).toContain("## 覚えておきたいこと");
		expect(content).toContain("- 目標: 再開時に過去の文脈を思い出す");
		expect(content).toContain("- 好み: 短い要約を好む");
		expect(content).toContain("## 直近の会話履歴");
		expect(content).toContain("### 2026-01-02 会話: 再開コンテキストの相談");
		expect(content).toContain("直近の記憶を要約して渡す話をした。");
	});

	test("memory DB がなければ古い RESUME-CONTEXT.md を削除する", async () => {
		const root = createTempRoot();
		const memoryDataDir: string = join(root, "memory");
		const overlayDir: string = join(root, "context");
		const guildId = "123456789012345678";
		const stalePath = join(overlayDir, "guilds", guildId, "RESUME-CONTEXT.md");
		mkdirSync(join(overlayDir, "guilds", guildId), { recursive: true });
		writeFileSync(stalePath, "stale");

		const service = new ResumeContextService({ memoryDataDir, overlayDir });
		await service.updateGuild(guildId);
		service.close();

		expect(existsSync(stalePath)).toBe(false);
	});
});
