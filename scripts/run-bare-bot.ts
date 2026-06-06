import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { prepareBareConfig } from "./prepare-bare-config.ts";

export const DEFAULT_BARE_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_WAIT_FOR_OLLAMA_SECONDS = 60;

export interface BareRuntimeOptions {
	appRoot: string;
	xdgConfigHome: string;
	xdgDataHome: string;
	sourceConfigPath: string;
	configPath: string;
	ollamaBaseUrl: string;
	ollamaHost: string;
	waitForOllamaSeconds: number;
	xvfbDisplay: string;
}

export function parseOllamaHost(ollamaBaseUrl: string): string {
	const url = new URL(ollamaBaseUrl);
	if (!url.host) {
		throw new Error(`ollama host is missing in URL: ${ollamaBaseUrl}`);
	}
	return url.host;
}

function nonEmptyOr(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
	if (!value) return defaultValue;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`expected positive integer, got: ${value}`);
	}
	return parsed;
}

export function resolveBareRuntimeOptions(
	env: NodeJS.ProcessEnv = process.env,
): BareRuntimeOptions {
	const appRoot = resolve(nonEmptyOr(env.APP_ROOT, resolve(import.meta.dirname, "..")));
	const home = env.HOME?.trim();
	if (!home) {
		throw new Error("HOME is required");
	}

	const xdgConfigHome = resolve(nonEmptyOr(env.XDG_CONFIG_HOME, resolve(home, ".config")));
	const xdgDataHome = resolve(nonEmptyOr(env.XDG_DATA_HOME, resolve(home, ".local", "share")));
	const sourceConfigPath = resolve(
		nonEmptyOr(env.VICISSITUDE_SOURCE_CONFIG_PATH, resolve(appRoot, "config", "default.json")),
	);
	const configPath = resolve(
		nonEmptyOr(env.VICISSITUDE_CONFIG_PATH, resolve(xdgConfigHome, "vicissitude", "config.json")),
	);
	const ollamaBaseUrl = nonEmptyOr(env.VICISSITUDE_OLLAMA_BASE_URL, DEFAULT_BARE_OLLAMA_BASE_URL);
	const ollamaHost = nonEmptyOr(env.OLLAMA_HOST, parseOllamaHost(ollamaBaseUrl));
	const waitForOllamaSeconds = parsePositiveInteger(
		env.VICISSITUDE_WAIT_FOR_OLLAMA_SECONDS,
		DEFAULT_WAIT_FOR_OLLAMA_SECONDS,
	);
	const xvfbDisplay = nonEmptyOr(env.XVFB_DISPLAY, ":99");

	return {
		appRoot,
		xdgConfigHome,
		xdgDataHome,
		sourceConfigPath,
		configPath,
		ollamaBaseUrl,
		ollamaHost,
		waitForOllamaSeconds,
		xvfbDisplay,
	};
}

export function buildBareRuntimeEnv(
	baseEnv: NodeJS.ProcessEnv,
	options: BareRuntimeOptions,
): Record<string, string> {
	return {
		...baseEnv,
		APP_ROOT: options.appRoot,
		XDG_CONFIG_HOME: options.xdgConfigHome,
		XDG_DATA_HOME: options.xdgDataHome,
		VICISSITUDE_SOURCE_CONFIG_PATH: options.sourceConfigPath,
		VICISSITUDE_CONFIG_PATH: options.configPath,
		VICISSITUDE_OLLAMA_BASE_URL: options.ollamaBaseUrl,
		OLLAMA_HOST: options.ollamaHost,
	};
}

export function readMemoryEmbeddingModel(configPath: string): string | null {
	const profile = JSON.parse(readFileSync(configPath, "utf8")) as {
		models?: {
			memory?: {
				embeddingModel?: string;
			};
		};
	};
	const model = profile.models?.memory?.embeddingModel?.trim();
	return model && model.length > 0 ? model : null;
}

async function isOllamaReady(ollamaBaseUrl: string): Promise<boolean> {
	try {
		const response = await fetch(new URL("/api/tags", ollamaBaseUrl), {
			signal: AbortSignal.timeout(1_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function waitForOllamaReady(
	ollamaExited: Promise<number>,
	ollamaBaseUrl: string,
	waitForOllamaSeconds: number,
): Promise<void> {
	const poll = async (remainingAttempts: number): Promise<void> => {
		if (await isOllamaReady(ollamaBaseUrl)) {
			return;
		}
		if (remainingAttempts <= 0) {
			throw new Error(`ollama did not become ready within ${String(waitForOllamaSeconds)}s`);
		}

		const outcome = await Promise.race([
			ollamaExited.then((code) => ({ type: "exit" as const, code })),
			Bun.sleep(1_000).then(() => ({ type: "tick" as const })),
		]);
		if (outcome.type === "exit") {
			throw new Error(`ollama exited before ready (code: ${String(outcome.code)})`);
		}
		await poll(remainingAttempts - 1);
	};

	await poll(waitForOllamaSeconds);
}

export async function ensureOllamaModel(
	model: string | null,
	env: Record<string, string>,
	cwd: string,
): Promise<void> {
	if (!model) return;

	const showProc = Bun.spawnSync(["ollama", "show", model], {
		cwd,
		env,
		stdout: "ignore",
		stderr: "ignore",
	});
	if (showProc.exitCode === 0) {
		return;
	}

	console.log(`[bare-bot] pulling Ollama model: ${model}`);
	const pullProc = Bun.spawn(["ollama", "pull", model], {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await pullProc.exited;
	if (exitCode !== 0) {
		throw new Error(`ollama pull failed for ${model} (code: ${String(exitCode)})`);
	}
}

async function terminateProcess(proc: {
	kill: (signal?: number | NodeJS.Signals) => unknown;
	exited: Promise<number>;
}) {
	try {
		proc.kill("SIGTERM");
	} catch {
		return;
	}
	await Promise.race([proc.exited, Bun.sleep(5_000)]);
	try {
		proc.kill("SIGKILL");
	} catch {
		// already exited
	}
}

function maybeStartXvfb(env: Record<string, string>, options: BareRuntimeOptions) {
	if (process.platform !== "linux") return null;
	if (env.DISPLAY?.trim()) return null;
	const xvfb = Bun.which("Xvfb");
	if (!xvfb) return null;
	if (options.xvfbDisplay.startsWith(":")) {
		const displayId = options.xvfbDisplay.slice(1);
		if (displayId.length > 0 && existsSync(`/tmp/.X${displayId}-lock`)) {
			env.DISPLAY = options.xvfbDisplay;
			return null;
		}
	}

	env.DISPLAY = options.xvfbDisplay;
	return Bun.spawn([xvfb, options.xvfbDisplay, "-screen", "0", "1280x720x24"], {
		cwd: options.appRoot,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
}

export async function runBareBot(
	botArgs: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const options = resolveBareRuntimeOptions(env);
	mkdirSync(dirname(options.configPath), { recursive: true });
	mkdirSync(resolve(options.xdgDataHome, "opencode"), { recursive: true });
	mkdirSync(resolve(options.appRoot, "data"), { recursive: true });

	prepareBareConfig(options.sourceConfigPath, options.configPath, options.ollamaBaseUrl);
	const runtimeEnv = buildBareRuntimeEnv(env, options);
	const embeddingModel = readMemoryEmbeddingModel(options.configPath);

	let xvfbProc: ReturnType<typeof Bun.spawn> | null = null;
	let ollamaProc: ReturnType<typeof Bun.spawn> | null = null;
	let botProc: ReturnType<typeof Bun.spawn> | null = null;
	let cleanedUp = false;

	const cleanup = async () => {
		if (cleanedUp) return;
		cleanedUp = true;
		if (botProc) await terminateProcess(botProc);
		if (ollamaProc) await terminateProcess(ollamaProc);
		if (xvfbProc) await terminateProcess(xvfbProc);
	};

	const handleSignal = () => {
		void cleanup();
	};
	process.on("SIGINT", handleSignal);
	process.on("SIGTERM", handleSignal);

	try {
		xvfbProc = maybeStartXvfb(runtimeEnv, options);
		ollamaProc = Bun.spawn(["ollama", "serve"], {
			cwd: options.appRoot,
			env: runtimeEnv,
			stdout: "inherit",
			stderr: "inherit",
		});

		await waitForOllamaReady(
			ollamaProc.exited,
			options.ollamaBaseUrl,
			options.waitForOllamaSeconds,
		);
		await ensureOllamaModel(embeddingModel, runtimeEnv, options.appRoot);

		botProc = Bun.spawn(["nr", "start", ...botArgs], {
			cwd: options.appRoot,
			env: runtimeEnv,
			stdout: "inherit",
			stderr: "inherit",
		});

		const outcome = await Promise.race([
			ollamaProc.exited.then((code) => ({ process: "ollama" as const, code })),
			botProc.exited.then((code) => ({ process: "bot" as const, code })),
		]);

		if (outcome.process === "ollama") {
			if (botProc) await terminateProcess(botProc);
			throw new Error(`ollama exited unexpectedly (code: ${String(outcome.code)})`);
		}

		await cleanup();
		return outcome.code;
	} catch (error) {
		await cleanup();
		throw error;
	} finally {
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
	}
}

if (import.meta.main) {
	try {
		const exitCode = await runBareBot(process.argv.slice(2));
		process.exit(exitCode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[bare-bot] failed: ${message}`);
		process.exit(1);
	}
}
