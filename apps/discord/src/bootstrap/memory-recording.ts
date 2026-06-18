import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

import { GitHubIssueAdapter } from "@vicissitude/infrastructure/http/github-issue-adapter";
import { MemoryChatAdapter } from "@vicissitude/memory/chat-adapter";
import { CompositeLLMAdapter } from "@vicissitude/memory/composite-llm-adapter";
import { MemoryConversationRecorder } from "@vicissitude/memory/conversation-recorder";
import { CriticAuditor } from "@vicissitude/memory/critic-auditor";
import { DriftScoreCalculator } from "@vicissitude/memory/drift-score";
import type { MemoryLlmPort } from "@vicissitude/memory/llm-port";
import {
	agentScopeNamespace,
	HUA_SELF_SUBJECT,
	INTERNAL_NAMESPACE,
	resolveMemoryDbDir,
	resolveMemoryDbPath,
} from "@vicissitude/memory/namespace";
import { MemoryStorage } from "@vicissitude/memory/storage";
import type { PrometheusCollector } from "@vicissitude/observability/metrics";
import { OllamaEmbeddingAdapter } from "@vicissitude/ollama";
import {
	denyAllSkillPermission,
	OPENCODE_ALL_TOOLS_DISABLED,
} from "@vicissitude/opencode/constants";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import type { MemoryNamespace } from "@vicissitude/shared/namespace";
import type { CriticAuditorPort } from "@vicissitude/shared/ports";
import type { Logger } from "@vicissitude/shared/types";

import type { AppConfig } from "../config.ts";

interface MemoryResources {
	chatAdapter: MemoryChatAdapter;
	recorder: MemoryConversationRecorder;
	consolidationScheduler: ConsolidationScheduler;
}

export async function buildCriticAuditorAdapter(
	soulPath: string,
	llm: MemoryLlmPort,
	dataDir: string,
	getBotUserId: () => string | undefined,
): Promise<CriticAuditorPort | undefined> {
	const soulFile = Bun.file(soulPath);
	if (!(await soulFile.exists())) return undefined;

	const characterDefinition = await soulFile.text();
	const driftCalculator = new DriftScoreCalculator(llm, characterDefinition);
	await driftCalculator.init();

	const storageCache = new Map<string, MemoryStorage>();
	return {
		audit(subject: string) {
			// gateway.start() 前に audit が呼ばれた場合、bot user id 未解決のため早期 return
			// (namespace 解決は scopeId バリデーションを行うため、それより前に判定する)
			const botUserId = getBotUserId();
			if (!botUserId) return Promise.resolve({ status: "skipped", reason: "no_bot_id" });

			let storage = storageCache.get(subject);
			if (!storage) {
				const namespace: MemoryNamespace =
					subject === HUA_SELF_SUBJECT ? INTERNAL_NAMESPACE : agentScopeNamespace(subject);
				mkdirSync(resolveMemoryDbDir(dataDir, namespace), { recursive: true });
				storage = new MemoryStorage(resolveMemoryDbPath(dataDir, namespace));
				storageCache.set(subject, storage);
			}
			const auditor = new CriticAuditor({
				llm,
				storage,
				driftCalculator,
				characterDefinition,
				botUserId,
			});
			return auditor.audit(subject);
		},
	};
}

export async function setupMemoryRecording(
	config: AppConfig,
	logger: Logger,
	opts: {
		memoryPort: number;
		metricsCollector?: PrometheusCollector;
		embeddingAdapter?: OllamaEmbeddingAdapter;
		root: string;
		/**
		 * Bot の Discord user id を遅延解決するための callback。
		 * gateway.start() より前に setupMemoryRecording が呼ばれるため、
		 * audit 実行時に最新値を取得する必要がある。
		 * 未解決の間 (undefined を返す) は audit が no-op (null) になる。
		 */
		getBotUserId?: () => string | undefined;
	},
): Promise<MemoryResources | undefined> {
	const dataDir = resolve(config.dataDir, "memory");

	try {
		const memorySessionPort = new OpencodeSessionAdapter({
			port: opts.memoryPort,
			mcpServers: {},
			builtinTools: OPENCODE_ALL_TOOLS_DISABLED,
			skillPermission: denyAllSkillPermission(),
		});
		const chatAdapter = new MemoryChatAdapter(
			memorySessionPort,
			config.memory.providerId,
			config.memory.modelId,
			logger,
		);

		const ollama =
			opts.embeddingAdapter ??
			new OllamaEmbeddingAdapter(config.memory.ollamaBaseUrl, config.memory.embeddingModel);
		const llm = new CompositeLLMAdapter(chatAdapter, ollama);

		const overlaySoulPath = resolve(opts.root, "data/context/SOUL.md");
		const baseSoulPath = resolve(opts.root, "context/SOUL.md");
		const soulPath = existsSync(overlaySoulPath) ? overlaySoulPath : baseSoulPath;
		const criticAuditor = await buildCriticAuditorAdapter(soulPath, llm, dataDir, () =>
			opts.getBotUserId?.(),
		);

		const githubIssuePort = config.github
			? new GitHubIssueAdapter({
					token: config.github.token,
					owner: config.github.owner,
					repo: config.github.repo,
				})
			: undefined;

		const recorder = new MemoryConversationRecorder(llm, dataDir);
		const consolidationScheduler = new ConsolidationScheduler({
			consolidator: recorder,
			logger,
			metrics: opts.metricsCollector,
			criticAuditor,
			issueReporter: githubIssuePort,
		});

		logger.info(`[bootstrap] Memory auto-recording enabled (port=${opts.memoryPort})`);
		return { chatAdapter, recorder, consolidationScheduler };
	} catch (err) {
		logger.error("[bootstrap] Memory auto-recording init failed, continuing without memory", err);
		return undefined;
	}
}
