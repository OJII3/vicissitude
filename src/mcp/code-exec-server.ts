import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
	name: "code-exec",
	version: "0.2.0",
});

const IMAGE = "vicissitude-code-exec";
const TIMEOUT_MS = 15_000;
const MAX_CODE_LENGTH = 10_000;
const MAX_OUTPUT_BYTES = 50_000;
const SUPPORTED_LANGUAGES = ["javascript", "typescript", "python", "shell"] as const;

type Language = (typeof SUPPORTED_LANGUAGES)[number];

function buildInnerCmd(language: Language, code: string): string[] {
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

function buildPodmanCmd(language: Language, code: string): string[] {
	return [
		"podman",
		"run",
		"--rm",
		"--network=none",
		"--read-only",
		"--tmpfs",
		"/tmp:size=10M",
		"--memory=128m",
		"--cpus=0.5",
		"--pids-limit=10",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--timeout=12",
		"--user=sandbox",
		IMAGE,
		...buildInnerCmd(language, code),
	];
}

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_BYTES) return output;
	const headSize = Math.floor(MAX_OUTPUT_BYTES * 0.8);
	const tailSize = MAX_OUTPUT_BYTES - headSize - 50;
	return `${output.slice(0, headSize)}\n\n... (truncated ${output.length - MAX_OUTPUT_BYTES} bytes) ...\n\n${output.slice(-tailSize)}`;
}

async function exec(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, TIMEOUT_MS);
	await proc.exited;
	clearTimeout(timeoutId);

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const raw = (stdout + stderr).trim() || "(no output)";
	const output = truncateOutput(raw);

	if (timedOut) return `Error (timeout after ${TIMEOUT_MS}ms):\n${output}`;
	return proc.exitCode === 0 ? output : `Error (exit ${proc.exitCode}):\n${output}`;
}

async function checkPodmanSetup(): Promise<void> {
	const podmanCheck = Bun.spawn(["podman", "--version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await podmanCheck.exited;
	if (podmanCheck.exitCode !== 0) {
		throw new Error("podman is not available. Install podman and try again.");
	}

	const imageCheck = Bun.spawn(["podman", "image", "exists", IMAGE], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await imageCheck.exited;
	if (imageCheck.exitCode !== 0) {
		throw new Error(`Container image '${IMAGE}' not found. Run 'nr container:build' first.`);
	}
}

server.tool(
	"execute_code",
	"Execute code in a sandboxed container and return the output",
	{
		language: z.enum(SUPPORTED_LANGUAGES),
		code: z.string().max(MAX_CODE_LENGTH),
	},
	async ({ language, code }) => {
		const cmd = buildPodmanCmd(language, code);
		const output = await exec(cmd);
		return { content: [{ type: "text", text: output }] };
	},
);

await checkPodmanSetup();

const transport = new StdioServerTransport();
await server.connect(transport);
