/* oxlint-disable max-lines -- shell workspace policy, session lifecycle, and audit helpers stay together */
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "fs";
import { dirname, resolve, sep } from "path";

const PODMAN_TIMEOUT_EXIT = 255;
const DEFAULT_NETWORK_PROFILE = "open";
const SHELL_WORKSPACE_CONTAINER_WORKDIR = "/workspace";

export const SHELL_WORKSPACE_DEFAULT_IMAGE = "vicissitude-code-exec";
export const SHELL_WORKSPACE_NETWORK_PROFILES = ["open", "none"] as const;

export type ShellWorkspaceNetworkProfile = (typeof SHELL_WORKSPACE_NETWORK_PROFILES)[number];

export interface ShellWorkspaceConfig {
	agentId: string;
	image: string;
	dataDir: string;
	hostDataDir?: string;
	auditLogPath: string;
	defaultTtlMinutes: number;
	maxTtlMinutes: number;
	defaultTimeoutSeconds: number;
	maxTimeoutSeconds: number;
	maxOutputChars: number;
	networkProfile: ShellWorkspaceNetworkProfile;
	now?: () => number;
	runProcess?: ProcessRunner;
}

export interface ShellSessionInfo {
	sessionId: string;
	label: string | null;
	createdAt: string;
	expiresAt: string;
	lastUsedAt: string;
	workspaceDir: string;
}

interface ShellSession {
	id: string;
	label: string | null;
	dir: string;
	hostDir: string;
	createdAt: number;
	expiresAt: number;
	lastUsedAt: number;
}

export interface ShellExecResult {
	sessionId: string;
	exitCode: number | null;
	durationMs: number;
	timedOut: boolean;
	output: string;
	outputTruncated: boolean;
}

export interface ProcessResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	outputTruncated: boolean;
}

export type ProcessRunner = (
	cmd: readonly string[],
	options: { timeoutMs: number; maxOutputChars: number },
) => Promise<ProcessResult>;

export interface ShellAuditRecord {
	timestamp: string;
	agent_id: string;
	session_id: string;
	command: string;
	cwd: string;
	exit_code: number | null;
	duration_ms: number;
	timed_out: boolean;
	output_truncated: boolean;
}

export function normalizeWorkspaceRelativePath(
	input: string | undefined,
	fieldName: string,
): string {
	const raw = (input ?? ".").trim();
	if (raw === "" || raw === ".") return ".";
	if (raw.includes("\0")) throw new Error(`${fieldName} must not contain NUL bytes`);
	if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
		throw new Error(`${fieldName} must be a relative path inside /workspace`);
	}

	const parts = raw.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
	if (parts.length === 0) return ".";
	if (parts.some((part) => part === "..")) {
		throw new Error(`${fieldName} must not contain '..'`);
	}
	return parts.join("/");
}

function normalizeLabel(input: string | undefined): string | null {
	const label = input?.trim();
	return label && label.length > 0 ? label : null;
}

export function buildShellPodmanCmd(options: {
	image: string;
	workspaceDir: string;
	cwd: string;
	command: string;
	timeoutSeconds: number;
	networkProfile?: ShellWorkspaceNetworkProfile;
}): string[] {
	const networkProfile = options.networkProfile ?? DEFAULT_NETWORK_PROFILE;
	const workdir =
		options.cwd === "."
			? SHELL_WORKSPACE_CONTAINER_WORKDIR
			: `${SHELL_WORKSPACE_CONTAINER_WORKDIR}/${options.cwd}`;
	return [
		"podman",
		"run",
		"--rm",
		`--network=${networkProfile === "open" ? "pasta" : "none"}`,
		"--tmpfs",
		"/tmp:size=512M",
		"--env",
		`HOME=${SHELL_WORKSPACE_CONTAINER_WORKDIR}/.home`,
		"--env",
		`XDG_CACHE_HOME=${SHELL_WORKSPACE_CONTAINER_WORKDIR}/.cache`,
		"--env",
		`XDG_CONFIG_HOME=${SHELL_WORKSPACE_CONTAINER_WORKDIR}/.config`,
		"--env",
		`TMPDIR=${SHELL_WORKSPACE_CONTAINER_WORKDIR}/.tmp`,
		"--memory=2g",
		"--cpus=2",
		"--pids-limit=512",
		"--timeout",
		String(options.timeoutSeconds + 5),
		"--user=root",
		"--volume",
		`${options.workspaceDir}:${SHELL_WORKSPACE_CONTAINER_WORKDIR}:rw`,
		"--workdir",
		workdir,
		options.image,
		"bash",
		"-lc",
		options.command,
	];
}

export class ShellWorkspaceManager {
	private readonly sessions = new Map<string, ShellSession>();
	private readonly now: () => number;
	private readonly runProcess: ProcessRunner;

	constructor(private readonly config: ShellWorkspaceConfig) {
		this.now = config.now ?? Date.now;
		this.runProcess = config.runProcess ?? runLimitedProcess;
		mkdirSync(config.dataDir, { recursive: true });
		mkdirSync(dirname(config.auditLogPath), { recursive: true });
	}

	startSession(input: { label?: string; ttlMinutes?: number }): ShellSessionInfo {
		const now = this.now();
		const ttlMinutes = input.ttlMinutes ?? this.config.defaultTtlMinutes;
		if (ttlMinutes < 1 || ttlMinutes > this.config.maxTtlMinutes) {
			throw new Error(`ttl_minutes must be between 1 and ${this.config.maxTtlMinutes}`);
		}

		const id = crypto.randomUUID();
		const dir = resolve(this.config.dataDir, id);
		const hostDir = this.config.hostDataDir ? resolve(this.config.hostDataDir, id) : dir;
		mkdirSync(dir, { recursive: false });
		chmodSync(dir, 0o777);
		for (const name of [".home", ".cache", ".config", ".tmp"]) {
			const sandboxDir = resolve(dir, name);
			mkdirSync(sandboxDir, { recursive: false });
			chmodSync(sandboxDir, 0o777);
		}

		const session: ShellSession = {
			id,
			label: normalizeLabel(input.label),
			dir,
			hostDir,
			createdAt: now,
			expiresAt: now + ttlMinutes * 60_000,
			lastUsedAt: now,
		};
		this.sessions.set(id, session);
		return this.toInfo(session);
	}

	async exec(input: {
		sessionId: string;
		command: string;
		cwd?: string;
		timeoutSeconds?: number;
	}): Promise<ShellExecResult> {
		const session = this.requireSession(input.sessionId);
		const cwd = normalizeWorkspaceRelativePath(input.cwd, "cwd");
		const timeoutSeconds = input.timeoutSeconds ?? this.config.defaultTimeoutSeconds;
		if (timeoutSeconds < 1 || timeoutSeconds > this.config.maxTimeoutSeconds) {
			throw new Error(`timeout_seconds must be between 1 and ${this.config.maxTimeoutSeconds}`);
		}

		session.lastUsedAt = this.now();
		const cmd = buildShellPodmanCmd({
			image: this.config.image,
			workspaceDir: session.hostDir,
			cwd,
			command: input.command,
			timeoutSeconds,
			networkProfile: this.config.networkProfile,
		});

		const startedAt = this.now();
		const result = await this.runProcess(cmd, {
			timeoutMs: (timeoutSeconds + 5) * 1_000,
			maxOutputChars: this.config.maxOutputChars,
		});
		const durationMs = this.now() - startedAt;
		const execResult: ShellExecResult = {
			sessionId: session.id,
			exitCode: result.exitCode,
			durationMs,
			timedOut: result.timedOut,
			output: result.output,
			outputTruncated: result.outputTruncated,
		};
		this.writeAudit({
			timestamp: new Date(this.now()).toISOString(),
			agent_id: this.config.agentId,
			session_id: session.id,
			command: input.command,
			cwd,
			exit_code: result.exitCode,
			duration_ms: durationMs,
			timed_out: result.timedOut,
			output_truncated: result.outputTruncated,
		});
		return execResult;
	}

	status(sessionId?: string): ShellSessionInfo[] {
		this.cleanupExpired();
		if (sessionId) return [this.toInfo(this.requireSession(sessionId))];
		return [...this.sessions.values()].map((session) => this.toInfo(session));
	}

	exportFile(sessionId: string, path: string): string {
		const session = this.requireSession(sessionId);
		const relativePath = normalizeWorkspaceRelativePath(path, "path");
		if (relativePath === ".") throw new Error("path must point to a file inside /workspace");

		const workspaceRoot = realpathSync(session.dir);
		const candidate = resolve(session.dir, relativePath);
		if (!existsSync(candidate)) throw new Error(`file not found: ${path}`);
		const realCandidate = realpathSync(candidate);
		if (realCandidate !== workspaceRoot && !realCandidate.startsWith(`${workspaceRoot}${sep}`)) {
			throw new Error("path must stay inside the workspace");
		}
		if (!statSync(realCandidate).isFile()) throw new Error(`path is not a file: ${path}`);
		return realCandidate;
	}

	stopSession(sessionId: string): ShellSessionInfo {
		const session = this.requireSession(sessionId);
		const info = this.toInfo(session);
		this.sessions.delete(sessionId);
		rmSync(session.dir, { recursive: true, force: true });
		return info;
	}

	cleanupExpired(): void {
		const now = this.now();
		for (const session of this.sessions.values()) {
			if (session.expiresAt <= now) {
				this.sessions.delete(session.id);
				rmSync(session.dir, { recursive: true, force: true });
			}
		}
	}

	close(): void {
		for (const session of this.sessions.values()) {
			rmSync(session.dir, { recursive: true, force: true });
		}
		this.sessions.clear();
	}

	private requireSession(sessionId: string): ShellSession {
		this.cleanupExpired();
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`unknown or expired session_id: ${sessionId}`);
		return session;
	}

	private toInfo(session: ShellSession): ShellSessionInfo {
		return {
			sessionId: session.id,
			label: session.label,
			createdAt: new Date(session.createdAt).toISOString(),
			expiresAt: new Date(session.expiresAt).toISOString(),
			lastUsedAt: new Date(session.lastUsedAt).toISOString(),
			workspaceDir: session.dir,
		};
	}

	private writeAudit(record: ShellAuditRecord): void {
		appendFileSync(this.config.auditLogPath, `${JSON.stringify(record)}\n`);
	}
}

async function runLimitedProcess(
	cmd: readonly string[],
	options: { timeoutMs: number; maxOutputChars: number },
): Promise<ProcessResult> {
	const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe" });

	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, options.timeoutMs);

	const byteLimit = options.maxOutputChars * 4;
	const [stdout, stderr] = await Promise.all([
		collectStream(proc.stdout as ReadableStream<Uint8Array>, byteLimit),
		collectStream(proc.stderr as ReadableStream<Uint8Array>, byteLimit),
	]);

	await proc.exited;
	clearTimeout(timeoutId);

	const raw = (stdout.text + stderr.text).trim() || "(no output)";
	const truncated = truncateOutput(raw, options.maxOutputChars);
	const podmanTimedOut = proc.exitCode === PODMAN_TIMEOUT_EXIT;

	return {
		exitCode: proc.exitCode,
		output: truncated.output,
		timedOut: timedOut || podmanTimedOut,
		outputTruncated: stdout.truncated || stderr.truncated || truncated.truncated,
	};
}

function truncateOutput(output: string, maxChars: number): { output: string; truncated: boolean } {
	if (output.length <= maxChars) return { output, truncated: false };
	const omitted = output.length - maxChars;
	const marker = `\n\n... (truncated ${omitted} chars) ...\n\n`;
	if (maxChars <= marker.length) return { output: output.slice(0, maxChars), truncated: true };
	const headSize = Math.floor((maxChars - marker.length) * 0.8);
	const tailSize = maxChars - marker.length - headSize;
	return {
		output: `${output.slice(0, headSize)}${marker}${output.slice(-tailSize)}`,
		truncated: true,
	};
}

async function collectStream(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<{ text: string; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for await (const chunk of stream) {
		const remaining = limit - total;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		if (remaining < chunk.length) {
			chunks.push(chunk.slice(0, remaining));
			total += remaining;
			truncated = true;
			break;
		}
		chunks.push(chunk);
		total += chunk.length;
	}
	return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}
