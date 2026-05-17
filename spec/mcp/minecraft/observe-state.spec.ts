import { describe, expect, mock, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBotContext } from "@vicissitude/minecraft/bot-context";
import type { BotContext } from "@vicissitude/minecraft/bot-context";
import type { JobManager } from "@vicissitude/minecraft/job-manager";
import { registerMinecraftTools } from "@vicissitude/minecraft/mcp-tools";

import { stubLogger } from "./stub-logger.ts";

// oxlint-disable-next-line no-explicit-any -- テスト用 MCP handler はツールごとに引数が異なる
type ToolHandler = (...args: any[]) => unknown;

function makeMockServer() {
	const tools = new Map<string, { config: unknown; handler: ToolHandler }>();
	return {
		server: {
			registerTool: (name: string, config: unknown, handler: ToolHandler) => {
				tools.set(name, { config, handler });
			},
		} as never as McpServer,
		getTool: (name: string) => tools.get(name),
	};
}

function makeFakeBot(options?: { health?: number }) {
	const bot = {
		entity: { position: { x: 0, y: 64, z: 0 } },
		health: options?.health ?? 20,
		food: 20,
		time: { timeOfDay: 6_000 },
		thunderState: 0,
		isRaining: false,
		entities: {},
		world: {
			raycast: mock(() => null),
		},
		inventory: {
			items: mock(() => []),
			slots: Array.from({ length: 46 }, () => null),
		},
		heldItem: null,
		respawn: mock(() => {}),
		look: mock(() => {}),
		setControlState: mock(() => {}),
		clearControlStates: mock(() => {}),
	};
	return bot;
}

function makeJobManager(options?: { stuck?: boolean; reason?: string }) {
	return {
		startJob: mock(() => "job-1"),
		cancelCurrentJob: mock(() => false),
		getCurrentJob: mock(() => null),
		getRecentJobs: mock(() => []),
		getCooldowns: mock(() => []),
		recordPositionSnapshot: mock(() => {}),
		isStuck: mock(() =>
			options?.stuck ? { stuck: true, reason: options.reason ?? "位置停滞" } : { stuck: false },
		),
	} as never as JobManager;
}

function registerTools(params: {
	ctx: BotContext;
	jobManager: JobManager;
	stuckRecovery?: {
		reconnect: () => void;
		onRecoverySuccess: () => void;
		requestSessionRotation?: () => Promise<void>;
		cooldownMs?: number;
	};
}) {
	const { server, getTool } = makeMockServer();
	registerMinecraftTools({
		server,
		ctx: params.ctx,
		jobManager: params.jobManager,
		viewerPort: 3007,
		options: { logger: stubLogger, stuckRecovery: params.stuckRecovery },
	});
	return { getTool };
}

function textOf(result: unknown): string {
	const r = result as { content: { text: string }[] };
	return r.content.at(0)?.text ?? "";
}

describe("observe_state", () => {
	test("死亡状態でも respawn せず明示復旧ツールを提案する", async () => {
		const ctx = createBotContext();
		const bot = makeFakeBot({ health: 0 });
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
		const { getTool } = registerTools({ ctx, jobManager: makeJobManager() });

		const result = await getTool("observe_state")?.handler();

		expect(bot.respawn).not.toHaveBeenCalled();
		const text = textOf(result);
		expect(text).toContain("死亡状態");
		expect(text).toContain("recover_state");
	});

	test("スタック検知時も stuck recovery を実行せず明示復旧ツールを提案する", async () => {
		const ctx = createBotContext();
		const bot = makeFakeBot();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
		const reconnect = mock(() => {});
		const onRecoverySuccess = mock(() => {});
		const { getTool } = registerTools({
			ctx,
			jobManager: makeJobManager({ stuck: true, reason: "位置停滞" }),
			stuckRecovery: { reconnect, onRecoverySuccess },
		});

		const result = await getTool("observe_state")?.handler();

		expect(bot.setControlState).not.toHaveBeenCalled();
		expect(reconnect).not.toHaveBeenCalled();
		expect(onRecoverySuccess).not.toHaveBeenCalled();
		const text = textOf(result);
		expect(text).toContain("スタック警告");
		expect(text).toContain("recover_state");
	});
});

describe("recover_state", () => {
	test("死亡状態では明示実行時だけ respawn する", async () => {
		const ctx = createBotContext();
		const bot = makeFakeBot({ health: 0 });
		bot.respawn.mockImplementation(() => {
			bot.health = 20;
		});
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
		const { getTool } = registerTools({ ctx, jobManager: makeJobManager() });

		const result = await getTool("recover_state")?.handler();

		expect(bot.respawn).toHaveBeenCalled();
		expect(textOf(result)).toContain("リスポーンに成功");
	});

	test("スタック状態では明示実行時だけ recovery action を実行する", async () => {
		const ctx = createBotContext();
		const bot = makeFakeBot();
		bot.setControlState.mockImplementation(() => {
			bot.entity.position.x += 5;
		});
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
		const onRecoverySuccess = mock(() => {});
		const { getTool } = registerTools({
			ctx,
			jobManager: makeJobManager({ stuck: true, reason: "位置停滞" }),
			stuckRecovery: { reconnect: mock(() => {}), onRecoverySuccess },
		});

		const result = await getTool("recover_state")?.handler();

		expect(bot.setControlState).toHaveBeenCalled();
		expect(onRecoverySuccess).toHaveBeenCalled();
		expect(textOf(result)).toContain("スタック復帰に成功");
	});

	test("復旧対象がない場合は action を実行しない", async () => {
		const ctx = createBotContext();
		const bot = makeFakeBot();
		ctx.setBot(bot as unknown as ReturnType<BotContext["getBot"]>);
		const { getTool } = registerTools({ ctx, jobManager: makeJobManager() });

		const result = await getTool("recover_state")?.handler();

		expect(bot.respawn).not.toHaveBeenCalled();
		expect(bot.setControlState).not.toHaveBeenCalled();
		expect(textOf(result)).toContain("復旧対象はありません");
	});
});
