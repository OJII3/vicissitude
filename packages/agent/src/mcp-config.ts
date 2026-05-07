import { resolve } from "path";

import type { McpServerConfig } from "./profile.ts";

export interface McpConfigOptions {
	appRoot: string;
	/** core MCP プロセスに渡す環境変数 */
	coreEnvironment: Record<string, string>;
	capabilities?: readonly AgentCapability[];
	shellWorkspace?: ShellWorkspaceMcpConfigOptions;
}

export type AgentCapability = "shell-workspace";

export interface ShellWorkspaceMcpConfigOptions {
	image: string;
	dataDir: string;
	hostDataDir?: string;
	auditLogPath: string;
	defaultTtlMinutes: number;
	maxTtlMinutes: number;
	defaultTimeoutSeconds: number;
	maxTimeoutSeconds: number;
	maxOutputChars: number;
}

/**
 * MCP サーバー設定を返す。
 *
 * core MCP は stdio (local) モードでエージェントごとに子プロセスとして起動される。
 * AGENT_ID 環境変数でエージェントの識別に使用される。
 */
export function mcpServerConfigs(agentId: string, opts: McpConfigOptions) {
	const { appRoot, coreEnvironment } = opts;
	const capabilities = new Set(opts.capabilities ?? []);

	const configs: Record<string, McpServerConfig> = {
		core: {
			type: "local",
			command: ["bun", "run", resolve(appRoot, "dist/core-server.js")],
			environment: {
				...coreEnvironment,
				AGENT_ID: agentId,
			},
		},
	};

	if (capabilities.has("shell-workspace")) {
		if (!opts.shellWorkspace) {
			throw new Error("shellWorkspace config is required when shell-workspace is enabled");
		}
		configs["shell-workspace"] = {
			type: "local",
			command: ["bun", "run", resolve(appRoot, "dist/shell-workspace-server.js")],
			environment: buildShellWorkspaceEnvironment(agentId, opts.shellWorkspace),
		};
	}

	return configs;
}

function buildShellWorkspaceEnvironment(
	agentId: string,
	config: ShellWorkspaceMcpConfigOptions,
): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		SHELL_WORKSPACE_AGENT_ID: agentId,
		SHELL_WORKSPACE_IMAGE: config.image,
		SHELL_WORKSPACE_DATA_DIR: config.dataDir,
		SHELL_WORKSPACE_AUDIT_LOG: config.auditLogPath,
		SHELL_WORKSPACE_DEFAULT_TTL_MINUTES: String(config.defaultTtlMinutes),
		SHELL_WORKSPACE_MAX_TTL_MINUTES: String(config.maxTtlMinutes),
		SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS: String(config.defaultTimeoutSeconds),
		SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS: String(config.maxTimeoutSeconds),
		SHELL_WORKSPACE_MAX_OUTPUT_CHARS: String(config.maxOutputChars),
	};
	if (config.hostDataDir) env.SHELL_WORKSPACE_HOST_DATA_DIR = config.hostDataDir;
	if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
	if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
	return env;
}

export interface McpMinecraftConfigOptions {
	appRoot: string;
	mcHost?: string;
	mcMcpPort?: string;
}

/**
 * Minecraft エージェント用 MCP サーバー設定を返す。
 * mc-bridge-server.ts（ブリッジ）+ minecraft MCP（MC_HOST 設定時のみ）。
 */
export function mcpMinecraftConfigs(
	opts: McpMinecraftConfigOptions,
): Record<string, McpServerConfig> {
	const { appRoot, mcHost, mcMcpPort } = opts;

	const configs: Record<string, McpServerConfig> = {
		"mc-bridge": {
			type: "local",
			command: ["bun", "run", resolve(appRoot, "dist/mc-bridge-server.js")],
			environment: {
				DATA_DIR: resolve(appRoot, "data"),
			},
		},
	};

	if (mcHost) {
		configs.minecraft = {
			type: "remote",
			url: `http://localhost:${mcMcpPort ?? "3001"}/mcp`,
		};
	}

	return configs;
}
