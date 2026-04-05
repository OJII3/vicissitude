import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	defaultSubject,
	discordGuildNamespace,
	type MemoryNamespace,
} from "@vicissitude/memory/namespace";
import type { Retrieval } from "@vicissitude/memory/retrieval";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import type { SemanticMemory } from "@vicissitude/memory/semantic-memory";
import { z } from "zod";

const GUILD_ID_REGEX = /^\d+$/;
const guildIdSchema = z.string().regex(GUILD_ID_REGEX).describe("Discord guild ID");

export interface MemoryReadServices {
	retrieval: Retrieval;
	semantic: SemanticMemory;
}

export interface MemoryDeps {
	getOrCreateMemory: (namespace: MemoryNamespace) => MemoryReadServices;
}

export function registerMemoryTools(
	server: McpServer,
	deps: MemoryDeps,
	boundNamespace?: MemoryNamespace,
): void {
	const { getOrCreateMemory } = deps;
	const boundGuildId =
		boundNamespace?.surface === "discord-guild" ? boundNamespace.guildId : undefined;

	function resolveNamespace(guildIdInput: string | undefined): MemoryNamespace | null {
		if (guildIdInput) return discordGuildNamespace(guildIdInput);
		return boundNamespace ?? null;
	}

	server.registerTool(
		"memory_retrieve",
		{
			description:
				"クエリに関連する長期記憶をハイブリッド検索（テキスト＋ベクトル＋FSRS リランキング）で取得する",
			inputSchema: {
				...(boundGuildId ? {} : { guild_id: guildIdSchema }),
				query: z.string().min(1).describe("検索クエリ"),
				limit: z.number().min(1).max(50).optional().describe("最大取得件数（デフォルト: 10）"),
			},
		},
		async ({ guild_id, query, limit }: { guild_id?: string; query: string; limit?: number }) => {
			const ns = resolveNamespace(guild_id);
			if (!ns) {
				return {
					content: [{ type: "text" as const, text: "Error: guild_id is required" }],
					isError: true,
				};
			}
			try {
				const mem = getOrCreateMemory(ns);
				const subject = defaultSubject(ns);
				const result = await mem.retrieval.retrieve(subject, query, {
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
							text: `memory_retrieve error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"memory_get_facts",
		{
			description: "蓄積されたファクト（意味記憶）一覧を取得する",
			inputSchema: {
				...(boundGuildId ? {} : { guild_id: guildIdSchema }),
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
		},
		async ({
			guild_id,
			category,
		}: {
			guild_id?: string;
			category?:
				| "identity"
				| "preference"
				| "interest"
				| "personality"
				| "relationship"
				| "experience"
				| "goal"
				| "guideline";
		}) => {
			const ns = resolveNamespace(guild_id);
			if (!ns) {
				return {
					content: [{ type: "text" as const, text: "Error: guild_id is required" }],
					isError: true,
				};
			}
			try {
				const mem = getOrCreateMemory(ns);
				const subject = defaultSubject(ns);
				const facts = category
					? await mem.semantic.getFactsByCategory(subject, category)
					: await mem.semantic.getFacts(subject);

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
							text: `memory_get_facts error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
