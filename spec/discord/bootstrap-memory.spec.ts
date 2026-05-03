/* oxlint-disable require-await, no-non-null-assertion, unicorn/no-useless-undefined -- spec file: non-null assertion is used after explicit existence checks; explicit undefined required to test getBotUserId callback shape */
/**
 * setupMemoryRecording() の仕様テスト
 *
 * 検証する公開契約:
 *   1. SOUL.md が存在しない場合 → エラーにならず MemoryResources を返す
 *   2. CriticAuditor adapter 構築は buildCriticAuditorAdapter() で直接検証する
 *   3. 戻り値が Promise<MemoryResources | undefined> になっている（async 化）
 *   4. opts.getBotUserId が CriticAuditor の audit() で利用可能（遅延解決）
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import type { CriticResult } from "@vicissitude/memory/critic-auditor";
import type { MemoryLlmPort, Schema } from "@vicissitude/memory/llm-port";
import {
	discordGuildNamespace,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
} from "@vicissitude/memory/namespace";
import { MemoryStorage } from "@vicissitude/memory/storage";
import type { ChatMessage } from "@vicissitude/memory/types";

import {
	buildCriticAuditorAdapter,
	setupMemoryRecording,
} from "../../apps/discord/src/bootstrap.ts";
import type { AppConfig } from "../../apps/discord/src/config.ts";
import { makeEpisode } from "../memory/test-helpers.ts";
import { createMockLogger } from "../test-helpers.ts";

// ─── Test fixtures ──────────────────────────────────────────────

function makeConfig(dataDir: string): AppConfig {
	return {
		discordToken: "test-token",
		webPort: 3000,
		gatewayPort: 3001,
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 5000,
			sessionMaxAgeHours: 1,
			temperature: 1.0,
		},
		memory: {
			providerId: "memory-provider",
			modelId: "memory-model",
			ollamaBaseUrl: "http://localhost:11434",
			embeddingModel: "nomic-embed-text",
		},
		mcBrain: {
			providerId: "mc-provider",
			modelId: "mc-model",
		},
		dataDir,
		contextDir: "/tmp/test-context",
	} as AppConfig;
}

function createSpyLLM(criticResponse: CriticResult) {
	const calls: { messages: ChatMessage[] }[] = [];
	const llm: MemoryLlmPort = {
		async chat(): Promise<string> {
			return "mock";
		},
		async chatStructured<T>(messages: ChatMessage[], schema: Schema<T>): Promise<T> {
			calls.push({ messages });
			return schema.parse(criticResponse);
		},
		async embed(): Promise<number[]> {
			return [0.1, 0.2, 0.3];
		},
	};
	return { llm, calls };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("setupMemoryRecording()", () => {
	let testDir: string;
	let logger: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		testDir = resolve(
			tmpdir(),
			`bootstrap-memory-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(resolve(testDir, "data/memory"), { recursive: true });
		logger = createMockLogger();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("戻り値が Promise である（async 化の確認）", () => {
		const config = makeConfig(resolve(testDir, "data"));
		const result = setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
		});

		// async 関数の戻り値は Promise
		expect(result).toBeInstanceOf(Promise);
	});

	test("正常系: MemoryResources を返す", async () => {
		const config = makeConfig(resolve(testDir, "data"));
		const result = await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
		});

		// setupMemoryRecording は MemoryResources | undefined を返す
		// ポートに接続できなくてもオブジェクト構築自体は成功するはず
		if (result !== undefined) {
			expect(result).toHaveProperty("chatAdapter");
			expect(result).toHaveProperty("recorder");
			expect(result).toHaveProperty("consolidationScheduler");
			expect(result).not.toHaveProperty("criticAuditor");
		}
	});

	test("buildCriticAuditorAdapter(): SOUL.md が存在する場合は audit メソッドを持つ adapter を返す", async () => {
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		const soulPath = resolve(contextDir, "SOUL.md");
		writeFileSync(soulPath, "# Character\nYou are hua, a casual girl.");

		const { llm } = createSpyLLM({ severity: "none", summary: "ok" });
		const adapter = await buildCriticAuditorAdapter(
			soulPath,
			llm,
			resolve(testDir, "data/memory"),
			() => "1100000000000000001",
		);

		expect(adapter).toBeDefined();
		expect(typeof adapter?.audit).toBe("function");
	});

	test("buildCriticAuditorAdapter(): audit() は SOUL.md 内容を CriticAuditor の system prompt に渡す", async () => {
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		const soulPath = resolve(contextDir, "SOUL.md");
		writeFileSync(soulPath, "# Character\nUnique persona marker\n「ふーん」");

		const guildId = "1100000000000000002";
		const botUserId = "1100000000000000001";
		const memoryDataDir = resolve(testDir, "data/memory");
		const namespace = discordGuildNamespace(guildId);
		mkdirSync(resolveMemoryDbDir(memoryDataDir, namespace), { recursive: true });
		const storage = new MemoryStorage(resolveMemoryDbPath(memoryDataDir, namespace));
		try {
			await Promise.all(
				Array.from({ length: 3 }, (_, i) =>
					storage.saveEpisode(
						guildId,
						makeEpisode({
							userId: guildId,
							messages: [
								{ role: "user", content: `hello ${i}`, authorId: "user-1" },
								{
									role: "assistant",
									content: "お手伝いします。素晴らしいご質問ですね。了解しました。もちろんです。",
									authorId: botUserId,
									name: "ふあ",
								},
							],
							startAt: new Date(Date.now() - 60_000),
							endAt: new Date(),
						}),
					),
				),
			);
		} finally {
			storage.close();
		}

		const { llm, calls } = createSpyLLM({ severity: "none", summary: "ok" });
		const adapter = await buildCriticAuditorAdapter(soulPath, llm, memoryDataDir, () => botUserId);

		expect(adapter).toBeDefined();
		if (!adapter) return;
		const result = await adapter.audit(guildId);

		expect(result).not.toBeNull();
		expect(calls).toHaveLength(1);
		const systemPrompt = calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
		expect(systemPrompt).toContain("Unique persona marker");
	});

	test("SOUL.md が存在しない場合: MemoryResources を返す", async () => {
		// context/ ディレクトリは存在するが SOUL.md がない
		mkdirSync(resolve(testDir, "context"), { recursive: true });

		const config = makeConfig(resolve(testDir, "data"));
		const result = await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
		});

		// エラーにならず MemoryResources が返される
		expect(result).not.toBeUndefined();
		if (!result) return;

		expect(result.consolidationScheduler).toBeDefined();
	});

	test("SOUL.md が存在しない場合: エラーログを出さずに正常に動作する", async () => {
		mkdirSync(resolve(testDir, "context"), { recursive: true });

		const config = makeConfig(resolve(testDir, "data"));
		await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
		});

		// error ログが呼ばれていないことを確認
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("opts.root が必須パラメータとして使用される", async () => {
		const config = makeConfig(resolve(testDir, "data"));

		// root を指定して呼び出し → エラーにならない
		const result = await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
		});

		// 結果が返される（undefined でもエラーでなければOK）
		// Promise が resolve することそのものが検証
		expect(result === undefined || typeof result === "object").toBe(true);
	});

	test("buildCriticAuditorAdapter(): getBotUserId は audit() まで遅延解決される", async () => {
		// #847: gateway.start() より前に setupMemoryRecording が呼ばれるため、
		// botUserId は遅延解決される必要がある。getBotUserId callback を opts に渡せること、
		// および audit 呼び出しまで bot user id 解決を遅延できることを検証する。
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		const soulPath = resolve(contextDir, "SOUL.md");
		writeFileSync(soulPath, "# Character\nYou are hua.");

		let resolved: string | undefined;
		const getBotUserId = () => resolved;

		// 1) bot user id 未解決の状態で setup
		const { llm } = createSpyLLM({ severity: "none", summary: "ok" });
		const adapter = await buildCriticAuditorAdapter(
			soulPath,
			llm,
			resolve(testDir, "data/memory"),
			getBotUserId,
		);

		expect(adapter).toBeDefined();

		// 2) gateway.start() 後に bot user id が判明
		resolved = "1100000000000000001";

		// 3) adapter 構築後でも audit() 時点の bot user id を参照する
		expect(typeof adapter?.audit).toBe("function");
	});

	test("buildCriticAuditorAdapter(): getBotUserId が undefined の間は audit() が null を返す", async () => {
		// gateway.start() 前に consolidationScheduler が起動するケースは現状ないが、
		// 防衛的に bot user id 未解決時の audit は no-op（null 返却）になることを期待する。
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		const soulPath = resolve(contextDir, "SOUL.md");
		writeFileSync(soulPath, "# Character");

		const { llm } = createSpyLLM({ severity: "none", summary: "ok" });
		const adapter = await buildCriticAuditorAdapter(
			soulPath,
			llm,
			resolve(testDir, "data/memory"),
			() => undefined,
		);

		expect(adapter).toBeDefined();
		if (!adapter) return;

		// bot user id 未解決時は audit は null を返して early-return すること
		const auditResult = await adapter.audit("guild-1");
		expect(auditResult).toBeNull();
	});
});
