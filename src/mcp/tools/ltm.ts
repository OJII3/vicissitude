import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Ltm, SemanticFact } from "../../ltm/index.ts";

const GUILD_ID_REGEX = /^\d+$/;
const guildIdSchema = z.string().regex(GUILD_ID_REGEX).describe("Discord guild ID");

export interface LtmDeps {
	getOrCreateLtm: (guildId: string) => Ltm;
}

export function registerLtmTools(server: McpServer, deps: LtmDeps): void {
	const { getOrCreateLtm } = deps;

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
				const ltm = getOrCreateLtm(guild_id);
				const result = await ltm.retrieval.retrieve(guild_id, query, {
					limit: limit ?? 10,
				});

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

	server.tool(
		"ltm_consolidate",
		"未統合のエピソードからファクト（意味記憶）を抽出・統合する",
		{
			guild_id: guildIdSchema,
		},
		async ({ guild_id }) => {
			try {
				const ltm = getOrCreateLtm(guild_id);
				const result = await ltm.consolidation.consolidate(guild_id);

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
				const ltm = getOrCreateLtm(guild_id);
				const facts = category
					? await ltm.semantic.getFactsByCategory(guild_id, category)
					: await ltm.semantic.getFacts(guild_id);

				if (facts.length === 0) {
					return {
						content: [{ type: "text", text: "ファクトはまだありません。" }],
					};
				}

				const lines = facts.map(
					(f: SemanticFact) => `- [${f.category}] ${f.fact} (keywords: ${f.keywords.join(", ")})`,
				);
				return {
					content: [
						{
							type: "text",
							text: `${facts.length} 件のファクト:\n${lines.join("\n")}`,
						},
					],
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
}
