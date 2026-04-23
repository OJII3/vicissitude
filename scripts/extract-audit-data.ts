/**
 * extract-audit-data.ts — character-audit スキル用のデータ抽出スクリプト。
 *
 * SQLite (data/memory/) からエピソード・ファクトを読み取り、
 * guild 別 overlay context と合わせて JSON で標準出力に書き出す。
 *
 * Usage:
 *   bun scripts/extract-audit-data.ts [--days N] [--max-episodes N] [--data-dir PATH]
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";

const PROJECT_DIR = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
	options: {
		days: { type: "string", default: "7" },
		"max-episodes": { type: "string", default: "50" },
		"data-dir": { type: "string", default: resolve(PROJECT_DIR, "data/memory") },
	},
	strict: true,
});

const DAYS = Number(args.days);
const MAX_EPISODES = Number(args["max-episodes"]);
const DATA_DIR = args["data-dir"]!;
const CONTEXT_DIR = resolve(PROJECT_DIR, "data/context");

// ---------------------------------------------------------------------------
// Types (output schema)
// ---------------------------------------------------------------------------
interface AuditMessage {
	role: string;
	content: string;
	name?: string;
	timestamp?: string;
}

interface AuditEpisode {
	id: string;
	title: string;
	summary: string;
	messages: AuditMessage[];
	surprise: number;
	startAt: string;
	endAt: string;
	consolidatedAt: string | null;
}

interface AuditFact {
	id: string;
	category: string;
	fact: string;
	keywords: string[];
	sourceEpisodicIds: string[];
	createdAt: string;
}

interface GuildOverlayContext {
	[filename: string]: string;
}

interface NamespaceData {
	namespace: string;
	guildId: string;
	overlayContext: GuildOverlayContext;
	episodes: AuditEpisode[];
	facts: AuditFact[];
}

interface AuditData {
	extractedAt: string;
	parameters: { days: number; maxEpisodes: number };
	namespaces: NamespaceData[];
}

// ---------------------------------------------------------------------------
// SQLite row types
// ---------------------------------------------------------------------------
interface EpisodeRow {
	id: string;
	title: string;
	summary: string;
	messages: string;
	surprise: number;
	start_at: number;
	end_at: number;
	consolidated_at: number | null;
}

interface FactRow {
	id: string;
	category: string;
	fact: string;
	keywords: string;
	source_episodic_ids: string;
	created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toISO(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function readGuildOverlay(guildId: string): GuildOverlayContext {
	const dir = resolve(CONTEXT_DIR, "guilds", guildId);
	if (!existsSync(dir)) return {};
	const ctx: GuildOverlayContext = {};
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md") || file.endsWith(".bak")) continue;
		const content = readTextFile(resolve(dir, file));
		if (content) ctx[file] = content;
	}
	return ctx;
}

function extractNamespace(dbPath: string, guildId: string): NamespaceData | null {
	if (!existsSync(dbPath)) return null;

	const db = new Database(dbPath, { readonly: true });
	try {
		const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

		// Episodes (直近 N 日、最大 MAX_EPISODES 件、新しい順)
		const episodes = db
			.prepare(
				`SELECT id, title, summary, messages, surprise, start_at, end_at, consolidated_at
				 FROM episodes
				 WHERE start_at >= ?
				 ORDER BY start_at DESC
				 LIMIT ?`,
			)
			.all(cutoff, MAX_EPISODES) as EpisodeRow[];

		// Active facts (invalid_at IS NULL)
		const facts = db
			.prepare(
				`SELECT id, category, fact, keywords, source_episodic_ids, created_at
				 FROM semantic_facts
				 WHERE invalid_at IS NULL
				 ORDER BY created_at DESC`,
			)
			.all() as FactRow[];

		if (episodes.length === 0 && facts.length === 0) return null;

		return {
			namespace: `discord-guild:${guildId}`,
			guildId,
			overlayContext: readGuildOverlay(guildId),
			episodes: episodes.map((e) => ({
				id: e.id,
				title: e.title,
				summary: e.summary,
				messages: (JSON.parse(e.messages) as AuditMessage[]).map((m) => ({
					role: m.role,
					content: m.content,
					...(m.name ? { name: m.name } : {}),
					...(m.timestamp ? { timestamp: m.timestamp } : {}),
				})),
				surprise: e.surprise,
				startAt: toISO(e.start_at),
				endAt: toISO(e.end_at),
				consolidatedAt: e.consolidated_at ? toISO(e.consolidated_at) : null,
			})),
			facts: facts.map((f) => ({
				id: f.id,
				category: f.category,
				fact: f.fact,
				keywords: JSON.parse(f.keywords) as string[],
				sourceEpisodicIds: JSON.parse(f.source_episodic_ids) as string[],
				createdAt: toISO(f.created_at),
			})),
		};
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
	const guildsDir = resolve(DATA_DIR, "guilds");
	const guildIds = existsSync(guildsDir)
		? readdirSync(guildsDir).filter((d) => /^\d+$/.test(d))
		: [];

	const namespaces: NamespaceData[] = [];
	for (const guildId of guildIds) {
		const dbPath = resolve(guildsDir, guildId, "memory.db");
		const ns = extractNamespace(dbPath, guildId);
		if (ns) namespaces.push(ns);
	}

	const output: AuditData = {
		extractedAt: new Date().toISOString(),
		parameters: { days: DAYS, maxEpisodes: MAX_EPISODES },
		namespaces,
	};

	console.log(JSON.stringify(output, null, 2));
}

main();
