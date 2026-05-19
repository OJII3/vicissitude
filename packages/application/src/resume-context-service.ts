/* oxlint-disable max-classes-per-file -- service, default source, and default writer define one public boundary */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import type { Episode } from "@vicissitude/memory/episode";
import {
	agentScopeNamespace,
	defaultSubject,
	discordScopeId,
	type MemoryNamespace,
	namespaceKey,
	resolveMemoryDbPath,
} from "@vicissitude/memory/namespace";
import type { SemanticFact } from "@vicissitude/memory/semantic-fact";
import { MemoryStorage } from "@vicissitude/memory/storage";
import type { Logger } from "@vicissitude/shared/types";

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_EPISODE_LIMIT = 5;
const DEFAULT_FACT_LIMIT = 6;
const EPISODE_SUMMARY_MAX = 280;
const EPISODE_TITLE_MAX = 80;

const FACT_CATEGORY_LABELS: Partial<Record<SemanticFact["category"], string>> = {
	goal: "目標",
	relationship: "関係",
	preference: "好み",
	interest: "関心",
	personality: "性格",
	identity: "人物像",
	experience: "経験",
};

const FACT_CATEGORY_PRIORITY = new Map<SemanticFact["category"], number>([
	["goal", 0],
	["relationship", 1],
	["preference", 2],
	["interest", 3],
	["personality", 4],
	["identity", 5],
	["experience", 6],
	["guideline", 7],
]);

export interface ResumeContextServiceDeps {
	memoryDataDir: string;
	overlayDir: string;
	logger?: Logger;
	memorySource?: ResumeContextMemorySource;
	writer?: ResumeContextWriter;
	lookbackMs?: number;
	episodeLimit?: number;
	factLimit?: number;
}

export interface ResumeContextSnapshot {
	episodes: Episode[];
	facts: SemanticFact[];
}

export interface ResumeContextMemorySource {
	read(
		namespace: MemoryNamespace,
		options: { sinceMs: number; episodeLimit: number },
	): Promise<ResumeContextSnapshot | null>;
	close(): void;
}

export interface ResumeContextWriter {
	writeGuildContext(guildId: string, content: string): void;
	removeGuildContext(guildId: string): void;
}

export class ResumeContextService {
	private readonly logger?: Logger;
	private readonly memorySource: ResumeContextMemorySource;
	private readonly writer: ResumeContextWriter;
	private readonly lookbackMs: number;
	private readonly episodeLimit: number;
	private readonly factLimit: number;

	constructor(private readonly deps: ResumeContextServiceDeps) {
		this.logger = deps.logger;
		this.memorySource =
			deps.memorySource ?? new MemoryStorageResumeContextSource(deps.memoryDataDir);
		this.writer = deps.writer ?? new FileResumeContextWriter(deps.overlayDir);
		this.lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
		this.episodeLimit = deps.episodeLimit ?? DEFAULT_EPISODE_LIMIT;
		this.factLimit = deps.factLimit ?? DEFAULT_FACT_LIMIT;
	}

	async updateGuilds(guildIds: string[]): Promise<void> {
		await Promise.all(guildIds.map((guildId) => this.updateGuild(guildId)));
	}

	async updateGuild(guildId: string): Promise<void> {
		const namespace = agentScopeNamespace(discordScopeId(guildId));

		try {
			const sinceMs = Date.now() - this.lookbackMs;
			const snapshot = await this.memorySource.read(namespace, {
				sinceMs,
				episodeLimit: this.episodeLimit,
			});
			if (!snapshot) {
				this.writer.removeGuildContext(guildId);
				return;
			}
			const content = renderResumeContext(snapshot.episodes, snapshot.facts, this.factLimit);
			if (!content) {
				this.writer.removeGuildContext(guildId);
				return;
			}
			this.writer.writeGuildContext(guildId, content);
		} catch (error) {
			this.logger?.warn(
				`[resume-context] failed to update guild ${guildId}: ${formatErrorMessage(error)}`,
				error,
			);
		}
	}

	close(): void {
		this.memorySource.close();
	}
}

export class MemoryStorageResumeContextSource implements ResumeContextMemorySource {
	private readonly instances = new Map<string, MemoryStorage>();

	constructor(private readonly memoryDataDir: string) {}

	async read(
		namespace: MemoryNamespace,
		options: { sinceMs: number; episodeLimit: number },
	): Promise<ResumeContextSnapshot | null> {
		const key = namespaceKey(namespace);
		const dbPath = resolveMemoryDbPath(this.memoryDataDir, namespace);

		if (!existsSync(dbPath)) return null;

		const storage = this.getOrCreate(key, dbPath);
		const userId = defaultSubject(namespace);
		const [episodes, facts] = await Promise.all([
			storage.getRecentEpisodes(userId, options.sinceMs, options.episodeLimit),
			storage.getFacts(userId),
		]);
		return { episodes, facts };
	}

	close(): void {
		for (const storage of this.instances.values()) {
			storage.close();
		}
		this.instances.clear();
	}

	private getOrCreate(key: string, dbPath: string): MemoryStorage {
		const existing = this.instances.get(key);
		if (existing) return existing;

		const storage = new MemoryStorage(dbPath);
		this.instances.set(key, storage);
		return storage;
	}
}

export class FileResumeContextWriter implements ResumeContextWriter {
	constructor(private readonly overlayDir: string) {}

	writeGuildContext(guildId: string, content: string): void {
		const outputDir: string = resolve(this.overlayDir, "guilds", guildId);
		const outputPath: string = resolve(outputDir, "RESUME-CONTEXT.md");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(outputPath, content);
	}

	removeGuildContext(guildId: string): void {
		const outputPath: string = resolve(this.overlayDir, "guilds", guildId, "RESUME-CONTEXT.md");
		rmSync(outputPath, { force: true });
	}
}

export function renderResumeContext(
	episodes: Episode[],
	facts: SemanticFact[],
	factLimit: number,
): string | null {
	const sections: string[] = [];
	const selectedFacts = selectFacts(facts, factLimit);

	if (selectedFacts.length > 0) {
		sections.push("## 覚えておきたいこと");
		sections.push(...selectedFacts.map((fact) => `- ${formatFact(fact)}`));
	}

	if (episodes.length > 0) {
		const lines = ["## 直近の会話履歴"];
		for (const episode of episodes) {
			lines.push(
				`### ${formatDate(episode.endAt)} 会話: ${trimLine(episode.title, EPISODE_TITLE_MAX)}`,
			);
			lines.push(trimParagraph(episode.summary, EPISODE_SUMMARY_MAX));
			lines.push("");
		}
		sections.push(lines.join("\n").trimEnd());
	}

	if (sections.length === 0) return null;
	return sections.join("\n\n").trim();
}

function selectFacts(facts: SemanticFact[], limit: number): SemanticFact[] {
	const seen = new Set<string>();
	return facts
		.filter((fact) => {
			const normalized = normalizeInline(fact.fact);
			if (!normalized || seen.has(normalized)) return false;
			seen.add(normalized);
			return true;
		})
		.toSorted((a, b) => {
			const priorityA = FACT_CATEGORY_PRIORITY.get(a.category) ?? Number.MAX_SAFE_INTEGER;
			const priorityB = FACT_CATEGORY_PRIORITY.get(b.category) ?? Number.MAX_SAFE_INTEGER;
			if (priorityA !== priorityB) return priorityA - priorityB;
			return b.createdAt.getTime() - a.createdAt.getTime();
		})
		.slice(0, limit);
}

function formatFact(fact: SemanticFact): string {
	const label = FACT_CATEGORY_LABELS[fact.category];
	const content = normalizeInline(fact.fact);
	return label ? `${label}: ${content}` : content;
}

function formatDate(date: Date): string {
	return new Intl.DateTimeFormat("ja-JP", {
		timeZone: "Asia/Tokyo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
		.format(date)
		.replaceAll("/", "-");
}

function trimParagraph(text: string, maxLength: number): string {
	return trimLine(text.replaceAll(/\s+/g, " "), maxLength);
}

function normalizeInline(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim();
}

function trimLine(text: string, maxLength: number): string {
	const normalized = normalizeInline(text);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}
