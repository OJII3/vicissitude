/* oxlint-disable max-lines-per-function -- MCP tool registration is declarative and easier to audit in one entry point */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
	SHELL_WORKSPACE_DEFAULT_IMAGE,
	ShellWorkspaceManager,
	type ShellWorkspaceConfig,
} from "./shell-workspace.ts";

const DEFAULT_DATA_DIR = "data/shell-workspaces";
const DEFAULT_AUDIT_LOG = "data/shell-workspace-audit.jsonl";
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const MAX_COMMAND_LENGTH = 8_000;
const MAX_LABEL_LENGTH = 80;
const MAX_CWD_LENGTH = 240;

function readIntEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function loadShellWorkspaceConfig(): ShellWorkspaceConfig {
	const defaultTtlMinutes = readIntEnv("SHELL_WORKSPACE_DEFAULT_TTL_MINUTES", 60);
	const maxTtlMinutes = readIntEnv("SHELL_WORKSPACE_MAX_TTL_MINUTES", 120);
	const defaultTimeoutSeconds = readIntEnv("SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS", 30);
	const maxTimeoutSeconds = readIntEnv("SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS", 120);

	if (defaultTtlMinutes > maxTtlMinutes) {
		throw new Error(
			"SHELL_WORKSPACE_DEFAULT_TTL_MINUTES must be <= SHELL_WORKSPACE_MAX_TTL_MINUTES",
		);
	}
	if (defaultTimeoutSeconds > maxTimeoutSeconds) {
		throw new Error(
			"SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS must be <= SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS",
		);
	}

	return {
		agentId: process.env.SHELL_WORKSPACE_AGENT_ID ?? "unknown",
		image: process.env.SHELL_WORKSPACE_IMAGE ?? SHELL_WORKSPACE_DEFAULT_IMAGE,
		dataDir: process.env.SHELL_WORKSPACE_DATA_DIR ?? DEFAULT_DATA_DIR,
		hostDataDir: process.env.SHELL_WORKSPACE_HOST_DATA_DIR,
		auditLogPath: process.env.SHELL_WORKSPACE_AUDIT_LOG ?? DEFAULT_AUDIT_LOG,
		defaultTtlMinutes,
		maxTtlMinutes,
		defaultTimeoutSeconds,
		maxTimeoutSeconds,
		maxOutputChars: readIntEnv("SHELL_WORKSPACE_MAX_OUTPUT_CHARS", 50_000),
	};
}

async function checkPodmanSetup(image: string): Promise<void> {
	const podmanCheck = Bun.spawn(["podman", "--version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await podmanCheck.exited;
	if (podmanCheck.exitCode !== 0) {
		throw new Error("podman is not available. Install podman and try again.");
	}

	const imageCheck = Bun.spawn(["podman", "image", "exists", image], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await imageCheck.exited;
	if (imageCheck.exitCode !== 0) {
		throw new Error(`Container image '${image}' not found.`);
	}
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function formatExecResult(result: Awaited<ReturnType<ShellWorkspaceManager["exec"]>>): string {
	return [
		`session_id: ${result.sessionId}`,
		`exit_code: ${result.exitCode ?? "null"}`,
		`duration_ms: ${result.durationMs}`,
		`timed_out: ${result.timedOut}`,
		`output_truncated: ${result.outputTruncated}`,
		"",
		"output:",
		result.output,
	].join("\n");
}

async function main(): Promise<void> {
	const config = loadShellWorkspaceConfig();
	await checkPodmanSetup(config.image);

	const manager = new ShellWorkspaceManager(config);
	const cleanupTimer = setInterval(() => manager.cleanupExpired(), CLEANUP_INTERVAL_MS);
	cleanupTimer.unref?.();

	const server = new McpServer({
		name: "shell-workspace",
		version: "0.1.0",
	});

	server.registerTool(
		"shell_start_session",
		{
			description: "Start an isolated shell workspace session",
			inputSchema: {
				label: z.string().max(MAX_LABEL_LENGTH).optional(),
				ttl_minutes: z.number().int().min(1).max(config.maxTtlMinutes).optional(),
			},
		},
		({ label, ttl_minutes }) => {
			const info = manager.startSession({ label, ttlMinutes: ttl_minutes });
			return { content: [{ type: "text", text: formatJson(info) }] };
		},
	);

	server.registerTool(
		"shell_exec",
		{
			description: "Execute a shell command inside an isolated /workspace sandbox",
			inputSchema: {
				session_id: z.uuid(),
				command: z.string().min(1).max(MAX_COMMAND_LENGTH),
				cwd: z.string().max(MAX_CWD_LENGTH).optional(),
				timeout_seconds: z.number().int().min(1).max(config.maxTimeoutSeconds).optional(),
			},
		},
		async ({ session_id, command, cwd, timeout_seconds }) => {
			const result = await manager.exec({
				sessionId: session_id,
				command,
				cwd,
				timeoutSeconds: timeout_seconds,
			});
			return { content: [{ type: "text", text: formatExecResult(result) }] };
		},
	);

	server.registerTool(
		"shell_status",
		{
			description: "List shell workspace sessions or inspect one session",
			inputSchema: {
				session_id: z.uuid().optional(),
			},
		},
		({ session_id }) => {
			return { content: [{ type: "text", text: formatJson(manager.status(session_id)) }] };
		},
	);

	server.registerTool(
		"shell_export_file",
		{
			description: "Return a host-local file path for a file inside the shell workspace",
			inputSchema: {
				session_id: z.uuid(),
				path: z.string().min(1).max(MAX_CWD_LENGTH),
			},
		},
		({ session_id, path }) => {
			const filePath = manager.exportFile(session_id, path);
			return { content: [{ type: "text", text: filePath }] };
		},
	);

	server.registerTool(
		"shell_stop_session",
		{
			description: "Stop a shell workspace session and delete its workspace",
			inputSchema: {
				session_id: z.uuid(),
			},
		},
		({ session_id }) => {
			const info = manager.stopSession(session_id);
			return { content: [{ type: "text", text: formatJson(info) }] };
		},
	);

	async function shutdown() {
		clearInterval(cleanupTimer);
		manager.close();
		await server.close();
		process.exit(0);
	}

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

void main();
