/**
 * 探索ツール仕様テスト
 *
 * 対象ツール:
 * - search_for_block: 段階的に探索範囲を広げながらブロックを探し、座標を返す（非同期ジョブ）
 * - explore_direction: 指定方向に一定距離移動し、新しいエリアを開拓する（非同期ジョブ）
 */

import { describe, expect, mock, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JobManager } from "@vicissitude/minecraft/job-manager";

// ---------------------------------------------------------------------------
// MockServer ヘルパー
// ---------------------------------------------------------------------------

// oxlint-disable-next-line no-explicit-any -- テスト用モックのため any を許容
type Handler = (...args: any[]) => unknown;

function makeMockServer() {
	const tools = new Map<string, { config: unknown; handler: Handler }>();
	return {
		server: {
			registerTool: (name: string, config: unknown, handler: Handler) => {
				tools.set(name, { config, handler });
			},
		} as never as McpServer,
		getTool: (name: string) => tools.get(name),
	};
}

// ---------------------------------------------------------------------------
// MockJobManager ヘルパー
// ---------------------------------------------------------------------------

function makeMockJobManager() {
	let jobCounter = 1;
	const startedJobs: { type: string; target: string }[] = [];

	return {
		jobManager: {
			startJob: mock((type: string, target: string, _executor: unknown) => {
				startedJobs.push({ type, target });
				return `job-${String(jobCounter++)}`;
			}),
			cancelCurrentJob: mock(() => false),
			getCurrentJob: mock(() => null),
			getRecentJobs: mock(() => []),
			getCooldowns: mock(() => new Map()),
			recordPositionSnapshot: mock(() => {}),
			isStuck: mock(() => ({ stuck: false })),
		} as never as JobManager,
		startedJobs,
	};
}

// ---------------------------------------------------------------------------
// makeBot ヘルパー
// ---------------------------------------------------------------------------

function makeBot(options?: { blocksByName?: Record<string, { id: number }> }) {
	return {
		entity: { position: { x: 0, y: 64, z: 0 } },
		registry: {
			blocksByName: options?.blocksByName ?? {
				oak_log: { id: 17 },
				stone: { id: 1 },
				diamond_ore: { id: 56 },
			},
		},
		pathfinder: {
			setMovements: mock(() => {}),
			movements: null,
			goto: mock(() => Promise.resolve()),
			stop: mock(() => {}),
		},
		findBlocks: mock(() => []),
		blockAt: mock(() => null),
	} as never;
}

// ---------------------------------------------------------------------------
// テスト対象モジュールの動的インポート
// ※ 実装前の仕様テストのため、インポートパスは実装時に決定される
// ---------------------------------------------------------------------------

// 実装後のインポートパス（実装時に packages/minecraft/src/actions/exploration.ts に配置する想定）
// import { registerSearchForBlock, registerExploreDirection } from "@vicissitude/minecraft/actions/exploration";

// 仕様テスト: MCP ツール登録関数を直接テストする
// GetBot 型: () => mineflayer.Bot | null
type GetBot = () => ReturnType<typeof makeBot> | null;

// 登録関数の型定義（実装前の仕様）
type RegisterSearchForBlock = (server: McpServer, getBot: GetBot, jobManager: JobManager) => void;

type RegisterExploreDirection = (server: McpServer, getBot: GetBot, jobManager: JobManager) => void;

const nullBot: GetBot = () => null;

// ---------------------------------------------------------------------------
// search_for_block 仕様テスト
// ---------------------------------------------------------------------------

describe("search_for_block", () => {
	async function getRegisterFn(): Promise<RegisterSearchForBlock> {
		const mod = await import("@vicissitude/minecraft/actions/exploration");
		return (mod as { registerSearchForBlock: RegisterSearchForBlock }).registerSearchForBlock;
	}

	test("ツールが存在し、blockName パラメータを受け取ること", async () => {
		const registerSearchForBlock = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();
		const getBot: GetBot = () => makeBot();

		registerSearchForBlock(server, getBot as never, jobManager);

		const tool = getTool("search_for_block");
		expect(tool).toBeDefined();
		// inputSchema に blockName が含まれていること（config.inputSchema として渡される）
		const config = tool?.config as { inputSchema?: Record<string, unknown> };
		expect(config?.inputSchema).toHaveProperty("blockName");
	});

	test("ボット未接続時にエラーメッセージを返すこと", async () => {
		const registerSearchForBlock = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();

		registerSearchForBlock(server, nullBot as never, jobManager);

		const tool = getTool("search_for_block");
		expect(tool).toBeDefined();
		const result = await tool?.handler({ blockName: "oak_log" });
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		expect(text).toContain("未接続");
	});

	test("不明なブロック名でエラーメッセージを返すこと", async () => {
		const registerSearchForBlock = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();
		const getBot: GetBot = () => makeBot({ blocksByName: { stone: { id: 1 } } });

		registerSearchForBlock(server, getBot as never, jobManager);

		const tool = getTool("search_for_block");
		expect(tool).toBeDefined();
		const result = await tool?.handler({ blockName: "unknown_block_xyz" });
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		expect(text).toContain("unknown_block_xyz");
	});

	test("ジョブとして開始され、jobId を返すこと", async () => {
		const registerSearchForBlock = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();
		const getBot: GetBot = () => makeBot();

		registerSearchForBlock(server, getBot as never, jobManager);

		const tool = getTool("search_for_block");
		expect(tool).toBeDefined();
		const result = await tool?.handler({ blockName: "oak_log" });
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		// jobId が返されること
		expect(text).toMatch(/job-\d+/);
	});

	test("maxRadius パラメータを受け取ること（デフォルト: 128）", async () => {
		const registerSearchForBlock = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();
		const getBot: GetBot = () => makeBot();

		registerSearchForBlock(server, getBot as never, jobManager);

		const tool = getTool("search_for_block");
		expect(tool).toBeDefined();
		const config = tool?.config as { inputSchema?: Record<string, unknown> };
		// maxRadius はオプションパラメータであること
		expect(config?.inputSchema).toHaveProperty("maxRadius");
	});
});

// ---------------------------------------------------------------------------
// explore_direction 仕様テスト
// ---------------------------------------------------------------------------

describe("explore_direction", () => {
	async function getRegisterFn(): Promise<RegisterExploreDirection> {
		const mod = await import("@vicissitude/minecraft/actions/exploration");
		return (mod as { registerExploreDirection: RegisterExploreDirection }).registerExploreDirection;
	}

	test("ツールが存在し、direction と distance パラメータを受け取ること", async () => {
		const registerExploreDirection = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();
		const getBot: GetBot = () => makeBot();

		registerExploreDirection(server, getBot as never, jobManager);

		const tool = getTool("explore_direction");
		expect(tool).toBeDefined();
		const config = tool?.config as { inputSchema?: Record<string, unknown> };
		expect(config?.inputSchema).toHaveProperty("direction");
		expect(config?.inputSchema).toHaveProperty("distance");
	});

	test("ボット未接続時にエラーメッセージを返すこと", async () => {
		const registerExploreDirection = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();

		registerExploreDirection(server, nullBot as never, jobManager);

		const tool = getTool("explore_direction");
		expect(tool).toBeDefined();
		const result = await tool?.handler({ direction: "north", distance: 64 });
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		expect(text).toContain("未接続");
	});

	test("ジョブとして開始され、jobId を返すこと", async () => {
		const registerExploreDirection = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager } = makeMockJobManager();
		const getBot: GetBot = () => makeBot();

		registerExploreDirection(server, getBot as never, jobManager);

		const tool = getTool("explore_direction");
		expect(tool).toBeDefined();
		const result = await tool?.handler({ direction: "north", distance: 64 });
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		expect(text).toMatch(/job-\d+/);
	});

	test("方向未指定時にランダムな方向で実行されること", async () => {
		const registerExploreDirection = await getRegisterFn();
		const { server, getTool } = makeMockServer();
		const { jobManager, startedJobs } = makeMockJobManager();
		const getBot: GetBot = () => makeBot();

		registerExploreDirection(server, getBot as never, jobManager);

		const tool = getTool("explore_direction");
		expect(tool).toBeDefined();
		// direction を省略して呼び出す
		const result = await tool?.handler({ distance: 64 });
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		// ジョブが開始されること
		expect(text).toMatch(/job-\d+/);
		// ジョブが登録されていること
		expect(startedJobs.length).toBeGreaterThan(0);
	});
});
