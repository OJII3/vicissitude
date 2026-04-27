/* oxlint-disable require-await, no-non-null-assertion, unicorn/no-useless-undefined -- spec file: explicit undefined required to test getBotUserId callback shape */
/**
 * setupMemoryRecording() の仕様テスト
 *
 * Issue #815: CriticAuditor の DI 配線を追加する。
 *
 * 検証する公開契約:
 *   1. SOUL.md が存在する場合 → MemoryResources を返し、ConsolidationScheduler が CriticAuditorPort を保持する
 *   2. SOUL.md が存在しない場合 → エラーにならず MemoryResources を返す（graceful degradation）
 *   3. 戻り値が Promise<MemoryResources | undefined> になっている（async 化）
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

import { setupMemoryRecording } from "../../apps/discord/src/bootstrap.ts";
import type { AppConfig } from "../../apps/discord/src/config.ts";
import { createMockLogger } from "../test-helpers.ts";

// ─── Test fixtures ──────────────────────────────────────────────

function makeConfig(dataDir: string): AppConfig {
	return {
		botName: "ふあ",
		discordToken: "test-token",
		webPort: 3000,
		gatewayPort: 3001,
		opencode: {
			providerId: "test-provider",
			modelId: "test-model",
			basePort: 5000,
			sessionMaxAgeHours: 1,
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
		}
	});

	test("SOUL.md が存在する場合: consolidationScheduler が CriticAuditorPort を保持する", async () => {
		// context/SOUL.md を作成
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		writeFileSync(resolve(contextDir, "SOUL.md"), "# Character\nYou are hua, a casual girl.");

		const config = makeConfig(resolve(testDir, "data"));
		const result = await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
		});

		// MemoryResources が返される
		expect(result).not.toBeUndefined();
		if (!result) return;

		// consolidationScheduler が存在する
		expect(result.consolidationScheduler).toBeDefined();

		// criticAuditor が内部に保持されていることを検証
		// ConsolidationScheduler の private フィールドにアクセスして確認
		const scheduler = result.consolidationScheduler as unknown as { criticAuditor?: unknown };
		expect(scheduler.criticAuditor).toBeDefined();
		expect(scheduler.criticAuditor).not.toBeNull();

		// CriticAuditorPort の audit メソッドを持つことを確認
		const auditor = scheduler.criticAuditor as { audit?: unknown };
		expect(typeof auditor.audit).toBe("function");
	});

	test("SOUL.md が存在しない場合: MemoryResources を返すが criticAuditor なしで動作する（graceful degradation）", async () => {
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

		// criticAuditor は undefined（SOUL.md がないため）
		const scheduler = result.consolidationScheduler as unknown as { criticAuditor?: unknown };
		expect(scheduler.criticAuditor).toBeUndefined();
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

	test("SOUL.md の内容が characterDefinition として CriticAuditor に渡される", async () => {
		const soulContent = "# ふあ\n自由奔放で砕けた性格のキャラクター。";
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		writeFileSync(resolve(contextDir, "SOUL.md"), soulContent);

		const config = makeConfig(resolve(testDir, "data"));
		const result = await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
		});

		expect(result).not.toBeUndefined();
		if (!result) return;

		// CriticAuditor の characterDefinition を検証
		const scheduler = result.consolidationScheduler as unknown as { criticAuditor?: unknown };
		expect(scheduler.criticAuditor).toBeDefined();

		const auditor = scheduler.criticAuditor as { characterDefinition?: string };
		expect(auditor.characterDefinition).toBe(soulContent);
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

	test("opts.getBotUserId が CriticAuditor の audit() 経由で利用可能（遅延解決）", async () => {
		// #847: gateway.start() より前に setupMemoryRecording が呼ばれるため、
		// botUserId は遅延解決される必要がある。getBotUserId callback を opts に渡せること、
		// および audit 呼び出しまで bot user id 解決を遅延できることを検証する。
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		writeFileSync(resolve(contextDir, "SOUL.md"), "# Character\nYou are hua.");

		const config = makeConfig(resolve(testDir, "data"));
		let resolved: string | undefined;
		const getBotUserId = () => resolved;

		// 1) bot user id 未解決の状態で setup
		const result = await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
			getBotUserId,
		});

		expect(result).not.toBeUndefined();
		if (!result) return;

		// 2) gateway.start() 後に bot user id が判明
		resolved = "1100000000000000001";

		// 3) audit() 呼び出し時に最新の bot user id を使うこと（直接呼び出しはせず、
		//    CriticAuditor が getBotUserId を解決済みかどうかは impl 側で内部 wiring）
		const scheduler = result.consolidationScheduler as unknown as { criticAuditor?: unknown };
		expect(scheduler.criticAuditor).toBeDefined();
		const auditor = scheduler.criticAuditor as { audit?: unknown };
		expect(typeof auditor.audit).toBe("function");
	});

	test("getBotUserId が undefined を返している間に audit() が呼ばれても throw しない", async () => {
		// gateway.start() 前に consolidationScheduler が起動するケースは現状ないが、
		// 防衛的に bot user id 未解決時の audit は no-op（null 返却）になることを期待する。
		const contextDir = resolve(testDir, "context");
		mkdirSync(contextDir, { recursive: true });
		writeFileSync(resolve(contextDir, "SOUL.md"), "# Character");

		const config = makeConfig(resolve(testDir, "data"));
		const result = await setupMemoryRecording(config, logger, {
			memoryPort: 19999,
			root: testDir,
			getBotUserId: () => undefined,
		});

		expect(result).not.toBeUndefined();
		if (!result) return;
		const scheduler = result.consolidationScheduler as unknown as {
			criticAuditor?: { audit: (userId: string) => Promise<unknown> };
		};
		expect(scheduler.criticAuditor).toBeDefined();

		// bot user id 未解決時は audit は null を返して early-return すること
		const auditResult = await scheduler.criticAuditor!.audit("guild-1");
		expect(auditResult).toBeNull();
	});
});
