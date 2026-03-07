import { mkdirSync } from "fs";
import { resolve } from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	type Fenghuang,
	type SemanticFact,
	SQLiteStorageAdapter,
	createFenghuang,
} from "fenghuang";
import { z } from "zod";

import { CompositeLLMAdapter } from "../infrastructure/fenghuang/composite-llm-adapter.ts";
import { FenghuangChatAdapter } from "../infrastructure/fenghuang/fenghuang-chat-adapter.ts";
import { OllamaEmbeddingAdapter } from "../infrastructure/ollama/ollama-embedding-adapter.ts";

// --- Configuration from environment ---

const LTM_OPENCODE_PORT = Number(process.env.LTM_OPENCODE_PORT ?? "4095");
const LTM_MODEL_ID = process.env.LTM_MODEL_ID ?? "gpt-4o";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const LTM_EMBEDDING_MODEL = process.env.LTM_EMBEDDING_MODEL ?? "embeddinggemma";
const LTM_DATA_DIR = process.env.LTM_DATA_DIR ?? "data/fenghuang";

const GUILD_ID_REGEX = /^\d+$/;
const guildIdSchema = z.string().regex(GUILD_ID_REGEX).describe("Discord guild ID");

// --- Initialize adapters ---

const chatAdapter = new FenghuangChatAdapter(LTM_OPENCODE_PORT, LTM_MODEL_ID);
await chatAdapter.initialize();

const ollama = new OllamaEmbeddingAdapter(OLLAMA_BASE_URL, LTM_EMBEDDING_MODEL);
const llm = new CompositeLLMAdapter(chatAdapter, ollama);

// --- Per-guild Fenghuang instances ---

const instances = new Map<string, Fenghuang>();

function getOrCreate(guildId: string): Fenghuang {
	const existing = instances.get(guildId);
	if (existing) return existing;

	const dbDir = resolve(LTM_DATA_DIR, "guilds", guildId);
	mkdirSync(dbDir, { recursive: true });
	const storage = new SQLiteStorageAdapter(resolve(dbDir, "memory.db"));
	const instance = createFenghuang({ llm, storage });
	instances.set(guildId, instance);
	return instance;
}

// --- MCP Server ---

const server = new McpServer({ name: "ltm", version: "0.1.0" });

// --- ltm_ingest ---
server.tool(
	"ltm_ingest",
	"会話メッセージを長期記憶に取り込む。メッセージキューに追加し、閾値到達時にエピソードを自動生成する",
	{
		guild_id: guildIdSchema,
		messages: z
			.array(
				z.object({
					role: z.enum(["user", "assistant", "system"]),
					content: z.string().max(10000),
					timestamp: z.string().optional().describe("ISO8601 タイムスタンプ"),
				}),
			)
			.min(1)
			.max(100)
			.describe("取り込むメッセージ配列"),
	},
	async ({ guild_id, messages }) => {
		try {
			const feng = getOrCreate(guild_id);
			let totalEpisodes = 0;

			for (const msg of messages) {
				// oxlint-disable-next-line no-await-in-loop -- sequential: segmenter state depends on previous messages
				const episodes = await feng.segmenter.addMessage(guild_id, {
					role: msg.role,
					content: msg.content,
					timestamp: msg.timestamp ? new Date(msg.timestamp) : undefined,
				});
				totalEpisodes += episodes.length;
			}

			return {
				content: [
					{
						type: "text",
						text: `${messages.length} メッセージを取り込みました。${totalEpisodes > 0 ? `${totalEpisodes} 件のエピソードが生成されました。` : ""}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `ltm_ingest エラー: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// --- ltm_retrieve ---
server.tool(
	"ltm_retrieve",
	"クエリに関連する長期記憶をハイブリッド検索（テキスト＋ベクトル＋FSRS リランキング）で取得する",
	{
		guild_id: guildIdSchema,
		query: z.string().min(1).describe("検索クエリ"),
		limit: z.number().min(1).max(50).optional().describe("最大取得件数（デフォルト: 10）"),
	},
	async ({ guild_id, query, limit }) => {
		try {
			const feng = getOrCreate(guild_id);
			const result = await feng.retrieval.retrieve(guild_id, query, { limit: limit ?? 10 });

			const parts: string[] = [];

			if (result.episodes.length > 0) {
				parts.push("## エピソード記憶");
				for (const ep of result.episodes) {
					parts.push(`### ${ep.episode.title} (score: ${ep.score.toFixed(3)})`);
					parts.push(ep.episode.summary);
					parts.push("");
				}
			}

			if (result.facts.length > 0) {
				parts.push("## 意味記憶（ファクト）");
				for (const f of result.facts) {
					parts.push(`- [${f.fact.category}] ${f.fact.fact} (score: ${f.score.toFixed(3)})`);
				}
			}

			if (parts.length === 0) {
				parts.push("関連する記憶は見つかりませんでした。");
			}

			return { content: [{ type: "text", text: parts.join("\n") }] };
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `ltm_retrieve エラー: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// --- ltm_consolidate ---
server.tool(
	"ltm_consolidate",
	"未統合のエピソードからファクト（意味記憶）を抽出・統合する",
	{
		guild_id: guildIdSchema,
	},
	async ({ guild_id }) => {
		try {
			const feng = getOrCreate(guild_id);
			const result = await feng.consolidation.consolidate(guild_id);

			return {
				content: [
					{
						type: "text",
						text: [
							`統合完了:`,
							`- 処理エピソード: ${result.processedEpisodes}`,
							`- 新規ファクト: ${result.newFacts}`,
							`- 強化: ${result.reinforced}`,
							`- 更新: ${result.updated}`,
							`- 無効化: ${result.invalidated}`,
						].join("\n"),
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `ltm_consolidate エラー: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// --- ltm_get_facts ---
server.tool(
	"ltm_get_facts",
	"蓄積されたファクト（意味記憶）一覧を取得する",
	{
		guild_id: guildIdSchema,
		category: z
			.enum([
				"identity",
				"preference",
				"interest",
				"personality",
				"relationship",
				"experience",
				"goal",
				"guideline",
			])
			.optional()
			.describe("カテゴリでフィルタ（省略で全件）"),
	},
	async ({ guild_id, category }) => {
		try {
			const feng = getOrCreate(guild_id);
			const facts = category
				? await feng.semantic.getFactsByCategory(guild_id, category)
				: await feng.semantic.getFacts(guild_id);

			if (facts.length === 0) {
				return {
					content: [{ type: "text", text: "ファクトはまだありません。" }],
				};
			}

			const lines = facts.map(
				(f: SemanticFact) => `- [${f.category}] ${f.fact} (keywords: ${f.keywords.join(", ")})`,
			);
			return {
				content: [{ type: "text", text: `${facts.length} 件のファクト:\n${lines.join("\n")}` }],
			};
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `ltm_get_facts エラー: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			};
		}
	},
);

// --- Graceful Shutdown ---

async function shutdown() {
	await server.close();
	chatAdapter.close();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
