import { resolve } from "path";

import { addGitHubCredentialHelperEnvironment } from "@vicissitude/shared/github-auth-env";
import {
	workspaceGitConfigPath,
	writeShellWorkspaceGitConfig,
} from "@vicissitude/shared/workspace-gitconfig";

import { type AppConfig } from "../config.ts";

/** core MCP stdio プロセスに渡す環境変数を組み立てる */
export function buildCoreEnvironment(config: AppConfig, root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		OLLAMA_BASE_URL: config.memory.ollamaBaseUrl,
		MEMORY_OLLAMA_BASE_URL: config.memory.ollamaBaseUrl,
		MEMORY_EMBEDDING_MODEL: config.memory.embeddingModel,
		MEMORY_DATA_DIR: resolve(config.dataDir, "memory"),
		DATA_DIR: resolve(root, "data"),
	};
}

/** Discord MCP stdio プロセスに渡す環境変数を組み立てる */
export function buildDiscordEnvironment(config: AppConfig, root: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		DISCORD_TOKEN: config.discordToken,
		DATA_DIR: resolve(root, "data"),
	};

	if (config.emotionEstimation) {
		env.EMOTION_ESTIMATION_ENABLED = "true";
		env.EMOTION_PROVIDER_ID = config.emotionEstimation.providerId;
		env.EMOTION_MODEL_ID = config.emotionEstimation.modelId;
		if (config.emotionEstimation.ollamaBaseUrl) {
			env.EMOTION_OLLAMA_BASE_URL = config.emotionEstimation.ollamaBaseUrl;
		}
	}

	if (config.minecraft) {
		env.MC_HOST = config.minecraft.host;
	}

	if (config.shellAgent) {
		env.DISCORD_ATTACHMENT_ALLOWED_DIRS = config.shellAgent.dataDir;
	}

	return env;
}

export function prepareOpencodeShellAgentDirectory(
	config: AppConfig,
	agentId: string,
): string | undefined {
	if (!config.shellAgent) return;
	const safeAgentId = agentId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
	const directory = resolve(config.shellAgent.dataDir, "opencode", safeAgentId);
	if (config.shellAgent.git) writeShellWorkspaceGitConfig(directory, config.shellAgent.git);
	return directory;
}

export function buildOpencodeShellAgentEnvironment(
	config: AppConfig,
	directory: string | undefined,
): Record<string, string> | undefined {
	if (!config.shellAgent) return;
	const environment = config.shellAgent.environment ? { ...config.shellAgent.environment } : {};
	const baseEnvironment: Record<string, string> = { ...environment };
	if (config.shellAgent.git && directory) {
		baseEnvironment.GIT_CONFIG_GLOBAL = workspaceGitConfigPath(directory);
	}
	if (!config.shellAgent.backgroundSubagents)
		return addGitHubCredentialHelperEnvironment(baseEnvironment);
	return addGitHubCredentialHelperEnvironment({
		...baseEnvironment,
		OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
	});
}

const EMOTION_OPENCODE_PORT_OFFSET = 1000;

export function discordOpencodeSkillPaths(
	appRoot: string,
	options: { shellAgentEnabled: boolean },
): string[] {
	return [
		resolve(appRoot, "context/skills/discord"),
		...(options.shellAgentEnabled ? [resolve(appRoot, "context/skills/shell-worker")] : []),
	];
}

export function buildAgentDiscordEnvironment(
	config: AppConfig,
	baseEnvironment: Record<string, string>,
	agentPort: number,
): Record<string, string> {
	if (!config.emotionEstimation || config.emotionEstimation.providerId === "ollama") {
		return baseEnvironment;
	}
	return {
		...baseEnvironment,
		EMOTION_OPENCODE_PORT: String(agentPort + EMOTION_OPENCODE_PORT_OFFSET),
	};
}
