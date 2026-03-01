import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { $ } from "bun";
import { z } from "zod";

const server = new McpServer({
	name: "code-exec",
	version: "0.1.0",
});

const TIMEOUT_MS = 10_000;
const SUPPORTED_LANGUAGES = ["javascript", "typescript", "python", "shell"] as const;

const SAFE_ENV: Record<string, string> = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	HOME: process.env.HOME ?? "/tmp",
	LANG: process.env.LANG ?? "en_US.UTF-8",
};
type Language = (typeof SUPPORTED_LANGUAGES)[number];

function buildCmd(language: Language, code: string): string[] {
	switch (language) {
		case "javascript":
		case "typescript":
			return ["bun", "eval", code];
		case "python":
			return ["python3", "-c", code];
		case "shell":
			return ["bash", "-c", code];
	}
}

async function execWithTmux(cmd: string[]): Promise<string> {
	const sessionName = `exec-${Date.now()}`;
	const tmuxCmd = ["tmux", "new-session", "-d", "-s", sessionName, "-x", "200", "-y", "50", ...cmd];

	const proc = Bun.spawn(tmuxCmd, { stdout: "pipe", stderr: "pipe", env: SAFE_ENV });

	const timeout = setTimeout(() => {
		Bun.spawn(["tmux", "kill-session", "-t", sessionName], { env: SAFE_ENV });
	}, TIMEOUT_MS);

	await proc.exited;
	clearTimeout(timeout);

	const output = await $`tmux capture-pane -t ${sessionName} -p 2>/dev/null`.text().catch(() => "");

	await $`tmux kill-session -t ${sessionName} 2>/dev/null`.quiet().catch(() => {});

	return output.trim() || "(no output)";
}

async function execDirect(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: SAFE_ENV });

	const timeoutId = setTimeout(() => proc.kill(), TIMEOUT_MS);
	await proc.exited;
	clearTimeout(timeoutId);

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const output = (stdout + stderr).trim() || "(no output)";

	return proc.exitCode === 0 ? output : `Error (exit ${proc.exitCode}):\n${output}`;
}

server.tool(
	"execute_code",
	"Execute code and return the output (NOT sandboxed — runs on host)",
	{
		language: z.enum(SUPPORTED_LANGUAGES),
		code: z.string(),
	},
	async ({ language, code }) => {
		const cmd = buildCmd(language, code);
		let output: string;
		try {
			output = await execWithTmux(cmd);
		} catch {
			// tmux が使えない場合のフォールバック: 直接実行
			output = await execDirect(cmd);
		}
		return { content: [{ type: "text", text: output }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
