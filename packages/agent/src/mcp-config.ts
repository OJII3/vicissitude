import { resolve } from "path";

import type { ShellWorkspaceGitConfig } from "@vicissitude/shared/workspace-gitconfig";

import type { McpServerConfig } from "./profile.ts";

export interface McpConfigOptions {
	appRoot: string;
	/** core MCP プロセスに渡す環境変数 */
	coreEnvironment: Record<string, string>;
	/** Discord MCP プロセスに渡す環境変数。Discord agent だけが設定する。 */
	discord?: DiscordMcpConfigOptions;
	capabilities?: readonly AgentCapability[];
	shellWorkspace?: ShellWorkspaceMcpConfigOptions;
}

export type AgentCapability = "shell-workspace";

export interface ShellWorkspaceMcpConfigOptions {
	image: string;
	dataDir: string;
	hostDataDir?: string;
	auditLogPath: string;
	networkProfile: "open" | "none";
	environment?: Record<string, string>;
	git?: ShellWorkspaceGitConfig;
	defaultTtlMinutes: number;
	maxTtlMinutes: number;
	defaultTimeoutSeconds: number;
	maxTimeoutSeconds: number;
	maxOutputChars: number;
}

export interface DiscordMcpConfigOptions {
	environment: Record<string, string>;
}

function localBunCommand(appRoot: string, relativePath: string): [string, string, string] {
	const entrypoint = String(resolve(appRoot, relativePath));
	return ["bun", "run", entrypoint];
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
			command: localBunCommand(appRoot, "packages/mcp/src/core-server.ts"),
			environment: {
				...coreEnvironment,
				AGENT_ID: agentId,
			},
		},
	};

	if (opts.discord) {
		configs.discord = {
			type: "local",
			command: localBunCommand(appRoot, "packages/mcp/src/discord-server.ts"),
			environment: {
				...opts.discord.environment,
				AGENT_ID: agentId,
			},
		};
	}

	if (capabilities.has("shell-workspace")) {
		if (!opts.shellWorkspace) {
			throw new Error("shellWorkspace config is required when shell-workspace is enabled");
		}
		configs["shell-workspace"] = {
			type: "local",
			command: localBunCommand(appRoot, "packages/mcp/src/shell-workspace-server.ts"),
			environment: buildShellWorkspaceEnvironment(agentId, opts.shellWorkspace),
		};
	}

	return configs;
}

function buildShellWorkspaceEnvironment(
	agentId: string,
	config: ShellWorkspaceMcpConfigOptions,
): Record<string, string> {
	const forwardedEnvironment = config.environment ?? {};
	const forwardedEnvironmentNames = Object.keys(forwardedEnvironment);
	const env: Record<string, string> = {
		...forwardedEnvironment,
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		SHELL_WORKSPACE_AGENT_ID: agentId,
		SHELL_WORKSPACE_IMAGE: config.image,
		SHELL_WORKSPACE_DATA_DIR: config.dataDir,
		SHELL_WORKSPACE_AUDIT_LOG: config.auditLogPath,
		SHELL_WORKSPACE_NETWORK_PROFILE: config.networkProfile,
		SHELL_WORKSPACE_DEFAULT_TTL_MINUTES: String(config.defaultTtlMinutes),
		SHELL_WORKSPACE_MAX_TTL_MINUTES: String(config.maxTtlMinutes),
		SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS: String(config.defaultTimeoutSeconds),
		SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS: String(config.maxTimeoutSeconds),
		SHELL_WORKSPACE_MAX_OUTPUT_CHARS: String(config.maxOutputChars),
	};
	if (forwardedEnvironmentNames.length > 0) {
		env.SHELL_WORKSPACE_FORWARD_ENV = forwardedEnvironmentNames.join(",");
	}
	if (config.git) {
		env.SHELL_WORKSPACE_GIT_USER_NAME = config.git.userName;
		env.SHELL_WORKSPACE_GIT_USER_EMAIL = config.git.userEmail;
	}
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
 * mc-bridge-server.ts（ブリッジ）+ minecraft MCP（profile の minecraft 設定時のみ）。
 */
export function mcpMinecraftConfigs(
	opts: McpMinecraftConfigOptions,
): Record<string, McpServerConfig> {
	const { appRoot, mcHost, mcMcpPort } = opts;

	const configs: Record<string, McpServerConfig> = {
		"mc-bridge": {
			type: "local",
			command: localBunCommand(appRoot, "packages/minecraft/src/mc-bridge-server.ts"),
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
