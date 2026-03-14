import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import type { LtmFact, LtmFactReader } from "../../core/types.ts";
import { ContextBuilder } from "./context-builder.ts";

// ─── ヘルパー ────────────────────────────────────────────────────

function createTmpDirs(): { baseDir: string; overlayDir: string } {
	const baseDir = mkdtempSync(join(os.tmpdir(), "ctx-base-"));
	const overlayDir = mkdtempSync(join(os.tmpdir(), "ctx-overlay-"));
	return { baseDir, overlayDir };
}

function writeFile(dir: string, relativePath: string, content: string): void {
	const fullPath = join(dir, relativePath);
	const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
	mkdirSync(parentDir, { recursive: true });
	writeFileSync(fullPath, content);
}

function createMockLtmReader(facts: LtmFact[], relevantFacts?: LtmFact[]): LtmFactReader {
	return {
		getFacts: mock(() => Promise.resolve(facts)),
		getRelevantFacts: mock(() => Promise.resolve(relevantFacts ?? facts)),
		close: mock(() => Promise.resolve()),
	};
}

// ─── ContextBuilder ──────────────────────────────────────────────

describe("ContextBuilder", () => {
	describe("base/overlay のファイル優先順位", () => {
		it("overlay が base を上書きする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "base identity");
			writeFile(overlayDir, "IDENTITY.md", "overlay identity");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build();

			expect(result).toContain("overlay identity");
			expect(result).not.toContain("base identity");
		});

		it("overlay にファイルがなければ base にフォールバックする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "base identity");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build();

			expect(result).toContain("base identity");
		});
	});

	describe("Guild 固有ファイルのフォールバック", () => {
		it("Guild 固有ファイルがなければグローバルにフォールバックする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "MEMORY.md", "global memory");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");

			expect(result).toContain("global memory");
		});

		it("Guild 固有ファイルがあればそちらが優先される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "MEMORY.md", "global memory");
			writeFile(overlayDir, "guilds/123456789/MEMORY.md", "guild memory");

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");

			expect(result).toContain("guild memory");
			expect(result).not.toContain("global memory");
		});
	});

	describe("LTM ファクト注入", () => {
		it("guildId ありの場合に LTM ファクトが注入される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const facts: LtmFact[] = [
				{ content: "ユーザーAは猫が好き", category: "preference", createdAt: "2026-01-01" },
				{ content: "サーバー名はテスト鯖", category: "fact", createdAt: "2026-01-02" },
			];
			const reader = createMockLtmReader(facts);

			const builder = new ContextBuilder(overlayDir, baseDir, reader);
			const result = await builder.build("123456789");

			expect(result).toContain("<ltm-facts>");
			expect(result).toContain("[preference] ユーザーAは猫が好き");
			expect(result).toContain("[fact] サーバー名はテスト鯖");
			expect(reader.getFacts).toHaveBeenCalledWith("123456789");
		});

		it("guildId なしの場合は LTM ファクトが注入されない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const reader = createMockLtmReader([
				{ content: "test", category: "cat", createdAt: "2026-01-01" },
			]);

			const builder = new ContextBuilder(overlayDir, baseDir, reader);
			const result = await builder.build();

			expect(result).not.toContain("<ltm-facts>");
			expect(reader.getFacts).not.toHaveBeenCalled();
		});
	});

	describe("LTM ファクト関連性フィルタリング", () => {
		it("日次ログがある場合は getRelevantFacts が呼ばれる", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
			const today = new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);
			writeFile(overlayDir, `memory/${today}.md`, "今日はMinecraftで建築した");

			const allFacts: LtmFact[] = [
				{ content: "ユーザーAは猫が好き", category: "preference", createdAt: "2026-01-01" },
				{ content: "建築が得意", category: "interest", createdAt: "2026-01-02" },
			];
			const relevantFacts: LtmFact[] = [
				{ content: "建築が得意", category: "interest", createdAt: "2026-01-02" },
			];
			const reader = createMockLtmReader(allFacts, relevantFacts);

			const builder = new ContextBuilder(overlayDir, baseDir, reader);
			const result = await builder.build("123456789");

			expect(result).toContain("<ltm-facts>");
			expect(result).toContain("[interest] 建築が得意");
			expect(result).not.toContain("猫が好き");
			expect(reader.getRelevantFacts).toHaveBeenCalled();
			expect(reader.getFacts).not.toHaveBeenCalled();
		});

		it("日次ログがない場合は getFacts にフォールバックする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const facts: LtmFact[] = [
				{ content: "ユーザーAは猫が好き", category: "preference", createdAt: "2026-01-01" },
			];
			const reader = createMockLtmReader(facts);

			const builder = new ContextBuilder(overlayDir, baseDir, reader);
			const result = await builder.build("123456789");

			expect(result).toContain("[preference] ユーザーAは猫が好き");
			expect(reader.getFacts).toHaveBeenCalledWith("123456789");
			expect(reader.getRelevantFacts).not.toHaveBeenCalled();
		});

		it("日次ログが TOTAL_MAX 超過で切り詰められた場合は getFacts にフォールバックする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			// SHARED_FILES × PER_FILE_MAX で TOTAL_MAX を埋め尽くす
			const largeContent = "x".repeat(20_000);
			writeFile(baseDir, "IDENTITY.md", largeContent);
			writeFile(baseDir, "SOUL.md", largeContent);
			writeFile(baseDir, "AGENTS.md", largeContent);
			writeFile(baseDir, "TOOLS.md", largeContent);
			writeFile(baseDir, "HEARTBEAT.md", largeContent);
			writeFile(baseDir, "USER.md", largeContent);
			writeFile(baseDir, "MEMORY.md", largeContent);

			writeFile(baseDir, "LESSONS.md", largeContent);

			// 日次ログも大きくして TOTAL_MAX 超過させる
			// 8 ファイルのうち 7 件で ~140K 使用、残り ~10K に収まらない日次ログ
			const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
			const today = new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);
			writeFile(overlayDir, `memory/${today}.md`, "y".repeat(15_000));

			const facts: LtmFact[] = [
				{ content: "テスト", category: "preference", createdAt: "2026-01-01" },
			];
			const reader = createMockLtmReader(facts);

			const builder = new ContextBuilder(overlayDir, baseDir, reader);
			await builder.build("123456789");

			// 日次ログが入りきらなかったので getFacts にフォールバック
			expect(reader.getFacts).toHaveBeenCalledWith("123456789");
			expect(reader.getRelevantFacts).not.toHaveBeenCalled();
		});
	});

	describe("LTM ファクト取得の graceful degradation", () => {
		it("LTM ファクト取得で例外発生時はスキップして続行する", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			writeFile(baseDir, "IDENTITY.md", "identity content");

			const failingReader: LtmFactReader = {
				getFacts: mock(() => Promise.reject(new Error("LTM connection failed"))),
				getRelevantFacts: mock(() => Promise.reject(new Error("LTM connection failed"))),
				close: mock(() => Promise.resolve()),
			};

			const builder = new ContextBuilder(overlayDir, baseDir, failingReader);
			const result = await builder.build("123456789");

			// エラーがスローされずに結果が返る
			expect(result).toContain("identity content");
			expect(result).not.toContain("<ltm-facts>");
		});
	});

	describe("TOTAL_MAX による切り詰め", () => {
		it("TOTAL_MAX を超えるとそれ以降のセクションが省略される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			// TOTAL_MAX は 150_000。各 SHARED_FILE + MEMORY_FILE にラージコンテンツを書いて総量を超過させる
			// SHARED_FILES: IDENTITY, SOUL, AGENTS, TOOLS, HEARTBEAT, USER (6 files)
			// MEMORY_FILES: MEMORY, LESSONS (2 files)
			// PER_FILE_MAX は 20_000 なので、各ファイルに 20_000 文字書く → 8 files × 20_000 = 160_000 > 150_000
			const largeContent = "x".repeat(20_000);
			writeFile(baseDir, "IDENTITY.md", largeContent);
			writeFile(baseDir, "SOUL.md", largeContent);
			writeFile(baseDir, "AGENTS.md", largeContent);
			writeFile(baseDir, "TOOLS.md", largeContent);
			writeFile(baseDir, "HEARTBEAT.md", largeContent);
			writeFile(baseDir, "USER.md", largeContent);
			writeFile(baseDir, "MEMORY.md", largeContent);
			writeFile(baseDir, "LESSONS.md", largeContent);

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build();

			// 全セクションは入り切らないはず（TOTAL_MAX 超過で break）
			// LESSONS.md は末尾なので入らない可能性が高い
			expect(result.length).toBeLessThanOrEqual(160_000);
			// 最初のファイルは含まれる
			expect(result).toContain("<IDENTITY.md>");
			// 8 ファイル全てが含まれていないことを確認
			const sectionCount = (
				result.match(/<\/(IDENTITY|SOUL|AGENTS|TOOLS|HEARTBEAT|USER|MEMORY|LESSONS)\.md>/g) || []
			).length;
			expect(sectionCount).toBeLessThan(8);
		});
	});

	describe("guildId バリデーション", () => {
		it("不正な guildId（パストラバーサル）でエラーをスローする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			await expect(builder.build("../../../etc")).rejects.toThrow("Invalid guildId");
		});

		it("不正な guildId（英字）でエラーをスローする", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			await expect(builder.build("abc")).rejects.toThrow("Invalid guildId");
		});

		it("正しい guildId（数字のみ）は通る", async () => {
			const { baseDir, overlayDir } = createTmpDirs();
			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("123456789");
			expect(result).toContain("current_guild_id: 123456789");
		});
	});

	describe("guild-context セクション", () => {
		it("guildId ありの場合に guild-context が付与される", async () => {
			const { baseDir, overlayDir } = createTmpDirs();

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build("987654321");

			expect(result).toContain("<guild-context>");
			expect(result).toContain("current_guild_id: 987654321");
		});

		it("guildId なしの場合は guild-context が付与されない", async () => {
			const { baseDir, overlayDir } = createTmpDirs();

			const builder = new ContextBuilder(overlayDir, baseDir);
			const result = await builder.build();

			expect(result).not.toContain("<guild-context>");
		});
	});
});
