import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { resolveBareRuntimeOptions, runBareBot } from "./run-bare-bot.ts";

export type BareInstanceCommand = "run" | "start" | "stop" | "status" | "restart";

export interface BareControlPaths {
	instanceDir: string;
	lockDir: string;
	stateFile: string;
	logDir: string;
	logFile: string;
}

export interface BareInstanceState {
	pid: number;
	appRoot: string;
	logPath: string;
	startedAt: string;
	command: string;
}

export interface ParsedBareInstanceCommand {
	command: BareInstanceCommand;
	args: string[];
}

export function parseBareInstanceArgs(argv: string[]): ParsedBareInstanceCommand {
	const [command, ...args] = argv;
	if (
		command === "run" ||
		command === "start" ||
		command === "stop" ||
		command === "status" ||
		command === "restart"
	) {
		return { command, args };
	}
	throw new Error("usage: bun scripts/bare-instance.ts <run|start|stop|status|restart> [args...]");
}

export function resolveBareControlPaths(env: NodeJS.ProcessEnv = process.env): BareControlPaths {
	const options = resolveBareRuntimeOptions(env);
	const instanceDir = resolve(options.xdgDataHome, "vicissitude", "bare-instance");
	return {
		instanceDir,
		lockDir: resolve(instanceDir, "lock"),
		stateFile: resolve(instanceDir, "state.json"),
		logDir: resolve(options.xdgDataHome, "vicissitude", "logs"),
		logFile: resolve(options.xdgDataHome, "vicissitude", "logs", "bare.log"),
	};
}

export function isPidRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "EPERM" || error.code === "EACCES")
		) {
			return true;
		}
		return false;
	}
}

export function readBareInstanceState(paths: BareControlPaths): BareInstanceState | null {
	if (!existsSync(paths.stateFile)) return null;
	const content = readFileSync(paths.stateFile, "utf8");
	return JSON.parse(content) as BareInstanceState;
}

export function classifyBareInstanceState(
	paths: BareControlPaths,
	state: BareInstanceState | null,
): "running" | "stopped" | "stale" {
	if (!state) {
		return existsSync(paths.lockDir) ? "stale" : "stopped";
	}
	return isPidRunning(state.pid) ? "running" : "stale";
}

function ensureBareDirectories(paths: BareControlPaths): void {
	mkdirSync(paths.instanceDir, { recursive: true });
	mkdirSync(paths.logDir, { recursive: true });
}

function clearBareInstanceFiles(paths: BareControlPaths): void {
	rmSync(paths.stateFile, { force: true });
	rmSync(paths.lockDir, { recursive: true, force: true });
}

function writeBareInstanceState(paths: BareControlPaths, state: BareInstanceState): void {
	writeFileSync(paths.stateFile, `${JSON.stringify(state, null, "\t")}\n`);
}

function acquireBareInstanceLock(paths: BareControlPaths): void {
	try {
		mkdirSync(paths.lockDir);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
			throw error;
		}

		const existingState = readBareInstanceState(paths);
		const status = classifyBareInstanceState(paths, existingState);
		if (status === "running") {
			const pid = existingState?.pid ?? "unknown";
			throw new Error(`[bare-instance] already running (pid: ${String(pid)})`, {
				cause: error,
			});
		}

		clearBareInstanceFiles(paths);
		mkdirSync(paths.lockDir);
	}
}

function waitForBareInstanceState(
	paths: BareControlPaths,
	expected: "running" | "stopped",
	timeoutMs: number,
): Promise<boolean> {
	const poll = async (deadline: number): Promise<boolean> => {
		const status = classifyBareInstanceState(paths, readBareInstanceState(paths));
		if (status === expected) return true;
		if (expected === "stopped" && status === "stale") return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(200);
		return poll(deadline);
	};

	return poll(Date.now() + timeoutMs);
}

export async function runBareInstance(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const paths = resolveBareControlPaths(env);
	ensureBareDirectories(paths);
	acquireBareInstanceLock(paths);
	writeBareInstanceState(paths, {
		pid: process.pid,
		appRoot: resolveBareRuntimeOptions(env).appRoot,
		logPath: paths.logFile,
		startedAt: new Date().toISOString(),
		command: "run",
	});

	try {
		return await runBareBot(args, env);
	} finally {
		clearBareInstanceFiles(paths);
	}
}

export async function startBareInstance(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const paths = resolveBareControlPaths(env);
	ensureBareDirectories(paths);

	const currentState = readBareInstanceState(paths);
	const currentStatus = classifyBareInstanceState(paths, currentState);
	if (currentStatus === "running") {
		console.log(`[bare-instance] already running (pid: ${String(currentState?.pid ?? "unknown")})`);
		return 0;
	}
	if (currentStatus === "stale") {
		clearBareInstanceFiles(paths);
	}

	const stdoutFd = openSync(paths.logFile, "a");
	const stderrFd = openSync(paths.logFile, "a");
	try {
		const proc = Bun.spawn([process.execPath, "scripts/bare-instance.ts", "run", ...args], {
			cwd: resolveBareRuntimeOptions(env).appRoot,
			env,
			stdin: "ignore",
			stdout: stdoutFd,
			stderr: stderrFd,
			detached: true,
		});
		if ("unref" in proc && typeof proc.unref === "function") {
			proc.unref();
		}

		const started = await waitForBareInstanceState(paths, "running", 5_000);
		if (!started) {
			throw new Error(`[bare-instance] failed to start. log: ${paths.logFile}`);
		}

		const state = readBareInstanceState(paths);
		console.log(`[bare-instance] started (pid: ${String(state?.pid ?? proc.pid)})`);
		console.log(`[bare-instance] log: ${paths.logFile}`);
		return 0;
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
}

export async function stopBareInstance(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const paths = resolveBareControlPaths(env);
	const state = readBareInstanceState(paths);
	const status = classifyBareInstanceState(paths, state);

	if (status === "stopped") {
		console.log("[bare-instance] not running");
		return 0;
	}
	if (status === "stale" || !state) {
		clearBareInstanceFiles(paths);
		console.log("[bare-instance] removed stale state");
		return 0;
	}

	process.kill(state.pid, "SIGTERM");
	if (await waitForBareInstanceState(paths, "stopped", 10_000)) {
		clearBareInstanceFiles(paths);
		console.log(`[bare-instance] stopped (pid: ${String(state.pid)})`);
		return 0;
	}

	process.kill(state.pid, "SIGKILL");
	await Bun.sleep(500);
	clearBareInstanceFiles(paths);
	console.log(`[bare-instance] killed (pid: ${String(state.pid)})`);
	return 0;
}

export function printBareInstanceStatus(env: NodeJS.ProcessEnv = process.env): number {
	const paths = resolveBareControlPaths(env);
	const state = readBareInstanceState(paths);
	const status = classifyBareInstanceState(paths, state);

	if (status === "running" && state) {
		console.log(`[bare-instance] running pid=${String(state.pid)}`);
		console.log(`[bare-instance] startedAt=${state.startedAt}`);
		console.log(`[bare-instance] log=${state.logPath}`);
		return 0;
	}

	if (status === "stale") {
		console.log("[bare-instance] stale");
		if (state) {
			console.log(`[bare-instance] lastPid=${String(state.pid)}`);
			console.log(`[bare-instance] log=${state.logPath}`);
		}
		return 0;
	}

	console.log("[bare-instance] stopped");
	return 0;
}

export async function restartBareInstance(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	await stopBareInstance(env);
	return startBareInstance(args, env);
}

if (import.meta.main) {
	try {
		const parsed = parseBareInstanceArgs(process.argv.slice(2));
		let exitCode = 0;
		switch (parsed.command) {
			case "run":
				exitCode = await runBareInstance(parsed.args);
				break;
			case "start":
				exitCode = await startBareInstance(parsed.args);
				break;
			case "stop":
				exitCode = await stopBareInstance();
				break;
			case "status":
				exitCode = printBareInstanceStatus();
				break;
			case "restart":
				exitCode = await restartBareInstance(parsed.args);
				break;
		}
		process.exit(exitCode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	}
}
