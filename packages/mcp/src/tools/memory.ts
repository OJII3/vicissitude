import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryReadServices } from "@vicissitude/memory";
import {
	defaultSubject,
	discordGuildNamespace,
	GUILD_ID_RE,
	INTERNAL_NAMESPACE,
	type MemoryNamespace,
} from "@vicissitude/memory/namespace";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import { z } from "zod";

const guildIdSchema = z.string().regex(GUILD_ID_RE).describe("Discord guild ID");

const formatFacts = (fs: SemanticFact[]) =>
	fs.map((f) => `- [${f.category}] ${f.fact} (keywords: ${f.keywords.join(", ")})`);

export interface MemoryDeps {
	getOrCreateMemory: (namespace: MemoryNamespace) => MemoryReadServices;
}

export function registerMemoryTools(
	server: McpServer,
	deps: MemoryDeps,
	boundNamespace?: MemoryNamespace,
): void {
	const { getOrCreateMemory } = deps;
	function resolveNamespace(guildIdInput: string | undefined): MemoryNamespace | null {
		if (boundNamespace) return boundNamespace;
		if (guildIdInput) return discordGuildNamespace(guildIdInput);
		return null;
	}

	server.registerTool(
		"memory_retrieve",
		{
			description:
				"Retrieve long-term memories related to the query via hybrid search (text + vector + FSRS re-ranking)",
			inputSchema: {
				...(boundNamespace ? {} : { guild_id: guildIdSchema }),
				query: z.string().min(1).describe("Search query"),
				limit: z.number().min(1).max(50).optional().describe("Max results (default: 10)"),
			},
		},
		async ({ guild_id, query, limit }: { guild_id?: string; query: string; limit?: number }) => {
			try {
				const ns = resolveNamespace(guild_id);
				if (!ns) {
					return {
						content: [{ type: "text" as const, text: "Error: namespace could not be resolved" }],
						isError: true,
					};
				}
				const mem = getOrCreateMemory(ns);
				const subject = defaultSubject(ns);
				const retrieveOpts = { limit: limit ?? 10 };

				const resultPromise = mem.retrieval.retrieve(subject, query, retrieveOpts);

				const internalResultPromise =
					ns.surface === "internal"
						? null
						: getOrCreateMemory(INTERNAL_NAMESPACE).retrieval.retrieve(
								defaultSubject(INTERNAL_NAMESPACE),
								query,
								retrieveOpts,
							);

				const [result, internalResult] = await Promise.all([resultPromise, internalResultPromise]);

				const parts: string[] = [];

				if (result.episodes.length > 0) {
					parts.push("## Episodic Memory");
					for (const ep of result.episodes) {
						parts.push(`### ${ep.episode.title} (score: ${ep.score.toFixed(3)})`);
						parts.push(ep.episode.summary);
						parts.push("");
					}
				}

				if (result.facts.length > 0) {
					parts.push("## Semantic Memory (Facts)");
					for (const f of result.facts) {
						parts.push(`- [${f.fact.category}] ${f.fact.fact} (score: ${f.score.toFixed(3)})`);
					}
				}

				if (internalResult) {
					if (internalResult.episodes.length > 0) {
						parts.push("## Hua's Own Memory (Episodes)");
						for (const ep of internalResult.episodes) {
							parts.push(`### ${ep.episode.title} (score: ${ep.score.toFixed(3)})`);
							parts.push(ep.episode.summary);
							parts.push("");
						}
					}

					if (internalResult.facts.length > 0) {
						parts.push("## Hua's Own Memory (Facts)");
						for (const f of internalResult.facts) {
							parts.push(`- [${f.fact.category}] ${f.fact.fact} (score: ${f.score.toFixed(3)})`);
						}
					}
				}

				if (parts.length === 0) {
					parts.push("No relevant memories found.");
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
			description: "List accumulated facts (semantic memory)",
			inputSchema: {
				...(boundNamespace ? {} : { guild_id: guildIdSchema }),
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
					.describe("Filter by category (omit for all)"),
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
			try {
				const ns = resolveNamespace(guild_id);
				if (!ns) {
					return {
						content: [{ type: "text" as const, text: "Error: namespace could not be resolved" }],
						isError: true,
					};
				}
				const mem = getOrCreateMemory(ns);
				const subject = defaultSubject(ns);
				const factsPromise = category
					? mem.semantic.getFactsByCategory(subject, category)
					: mem.semantic.getFacts(subject);

				const internalMem =
					ns.surface === "internal" ? null : getOrCreateMemory(INTERNAL_NAMESPACE);
				const internalFactsPromise = internalMem
					? category
						? internalMem.semantic.getFactsByCategory(defaultSubject(INTERNAL_NAMESPACE), category)
						: internalMem.semantic.getFacts(defaultSubject(INTERNAL_NAMESPACE))
					: null;

				const [facts, internalFacts] = await Promise.all([factsPromise, internalFactsPromise]);

				if (facts.length === 0 && (!internalFacts || internalFacts.length === 0)) {
					return {
						content: [{ type: "text", text: "No facts yet." }],
					};
				}

				const parts: string[] = [];
				if (facts.length > 0) {
					parts.push(`${facts.length} facts:`);
					parts.push(...formatFacts(facts));
				}
				if (internalFacts && internalFacts.length > 0) {
					parts.push(`\nHua's own memory (${internalFacts.length} facts):`);
					parts.push(...formatFacts(internalFacts));
				}

				return {
					content: [{ type: "text", text: parts.join("\n") }],
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
