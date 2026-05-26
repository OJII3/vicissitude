import { OllamaChatAdapter } from "@vicissitude/ollama/ollama-chat-adapter";
import {
	denyAllSkillPermission,
	OPENCODE_ALL_TOOLS_DISABLED,
} from "@vicissitude/opencode/constants";
import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import type { EmotionAnalyzer, LlmPromptPort } from "@vicissitude/shared/ports";
import type { Logger, OpencodeModel, OpencodeSessionPort } from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { SqliteEmotionProviderCooldownStore } from "@vicissitude/store/emotion-provider-cooldown-store";

import {
	createEmotionAnalyzerFromPromptPort,
	type EmotionAnalyzerOptions,
} from "./emotion-observability.ts";
export {
	createEmotionAnalyzerFromPromptPort,
	extractEmotionPromptErrorInfo,
} from "./emotion-observability.ts";
export type { EmotionAnalyzerOptions, EmotionPromptErrorInfo } from "./emotion-observability.ts";

const EMOTION_PROMPT_TIMEOUT_MS = 30_000;

export interface EmotionEstimationConfig {
	providerId: string;
	modelId: string;
	ollamaBaseUrl?: string;
	opencodePort?: number;
}

export interface EmotionAnalyzerHandle {
	analyzer: EmotionAnalyzer;
	close(): void;
}

export function readEmotionEstimationConfigFromEnv(
	env: Record<string, string | undefined>,
): EmotionEstimationConfig | undefined {
	if (env.EMOTION_ESTIMATION_ENABLED !== "true") return;

	const providerId = requireEnv(env, "EMOTION_PROVIDER_ID");
	const modelId = requireEnv(env, "EMOTION_MODEL_ID");
	if (providerId === "ollama") {
		return {
			providerId,
			modelId,
			ollamaBaseUrl: requireEnv(env, "EMOTION_OLLAMA_BASE_URL"),
		};
	}

	return {
		providerId,
		modelId,
		opencodePort: Number(requireEnv(env, "EMOTION_OPENCODE_PORT")),
	};
}

export function createEmotionAnalyzer(
	config: EmotionEstimationConfig | undefined,
	logger: Logger,
	options: EmotionAnalyzerOptions,
): EmotionAnalyzerHandle | undefined {
	if (!config) return;

	const llm = createEmotionPromptPort(config, logger);
	const analyzer = createEmotionAnalyzerFromPromptPort(llm, config, logger, options);
	return {
		analyzer,
		close() {
			if ("close" in llm && typeof llm.close === "function") {
				llm.close();
			}
		},
	};
}

export function createEmotionAnalyzerWithStoreDb(
	config: EmotionEstimationConfig | undefined,
	logger: Logger,
	db: StoreDb,
	options: Omit<EmotionAnalyzerOptions, "cooldownStore"> = {},
): EmotionAnalyzerHandle | undefined {
	return createEmotionAnalyzer(config, logger, {
		...options,
		cooldownStore: new SqliteEmotionProviderCooldownStore(db),
	});
}

function createEmotionPromptPort(config: EmotionEstimationConfig, logger: Logger): LlmPromptPort {
	if (config.providerId === "ollama") {
		if (!config.ollamaBaseUrl) {
			throw new Error("EMOTION_OLLAMA_BASE_URL is required when EMOTION_PROVIDER_ID=ollama");
		}
		return new OllamaChatAdapter(config.ollamaBaseUrl, config.modelId, logger);
	}

	const opencodePort = config.opencodePort;
	if (typeof opencodePort !== "number" || !Number.isInteger(opencodePort)) {
		throw new TypeError("EMOTION_OPENCODE_PORT is required for non-ollama emotion provider");
	}

	return new OpencodePromptAdapter(
		new OpencodeSessionAdapter({
			port: opencodePort,
			mcpServers: {},
			builtinTools: OPENCODE_ALL_TOOLS_DISABLED,
			skillPermission: denyAllSkillPermission(),
			logger,
		}),
		{ providerId: config.providerId, modelId: config.modelId },
		logger,
	);
}

function requireEnv(env: Record<string, string | undefined>, name: string): string {
	const value = env[name];
	if (value && value.trim()) return value;
	throw new Error(`${name} is required when emotion estimation is enabled`);
}

class OpencodePromptAdapter implements LlmPromptPort {
	constructor(
		private readonly sessionPort: OpencodeSessionPort,
		private readonly model: OpencodeModel,
		private readonly logger: Logger,
	) {}

	async prompt(text: string): Promise<string> {
		const sessionId = await this.sessionPort.createSession("emotion-estimation");
		try {
			const result = await this.sessionPort.prompt(
				{
					sessionId,
					text,
					model: this.model,
					tools: {},
				},
				AbortSignal.timeout(EMOTION_PROMPT_TIMEOUT_MS),
			);
			return result.text;
		} finally {
			try {
				await this.sessionPort.deleteSession(sessionId);
			} catch (error) {
				this.logger.warn("[emotion] failed to delete OpenCode session:", error);
			}
		}
	}

	close(): void {
		this.sessionPort.close();
	}
}
