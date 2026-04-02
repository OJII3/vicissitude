import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_DIR = resolve(import.meta.dirname, "..");
const LOG_DIR = resolve(PROJECT_DIR, "logs/auto-triage");
const MAX_BUDGET_USD = 10;
/** 1 hour */
const INTERVAL_SEC = 1 * 60 * 60;
/** 30 minutes — kill claude if no stdout output for this duration */
const STALL_TIMEOUT_MS = 30 * 60 * 1000;

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatTimestamp(): string {
	const now = new Date();
	return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

function tee(msg: string, logFile: string): void {
	console.log(msg);
	appendFileSync(logFile, `${msg}\n`);
}

function extractAssistantText(line: string): string[] {
	try {
		const obj = JSON.parse(line);
		if (obj.type !== "assistant") return [];
		const contents: unknown[] = obj.message?.content ?? [];
		return contents
			.filter(
				(c): c is { type: "text"; text: string } =>
					(c as { type: string }).type === "text" &&
					typeof (c as { text: unknown }).text === "string",
			)
			.map((c) => c.text);
	} catch {
		return [];
	}
}

async function runOnce(): Promise<number> {
	const timestamp = formatTimestamp();
	const logFile = resolve(LOG_DIR, `${timestamp}.log`);
	const jsonLog = resolve(LOG_DIR, `${timestamp}.jsonl`);

	tee(`[${timestamp}] auto-triage starting`, logFile);

	// main を最新化（worktree のベースになる）
	const fetchProc = Bun.spawn(["git", "fetch", "origin", "main"], {
		cwd: PROJECT_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(fetchProc.stdout).text(),
		new Response(fetchProc.stderr).text(),
	]);
	const fetchExitCode = await fetchProc.exited;
	tee((stdout + stderr).trimEnd(), logFile);
	if (fetchExitCode !== 0) {
		tee(
			`[WARN] git fetch origin main failed (exit: ${String(fetchExitCode)}); continuing with local state`,
			logFile,
		);
	}

	// --worktree で独立したワーキングツリーで作業（main を汚さない）
	const proc = Bun.spawn(
		[
			"claude",
			"-p",
			"/auto-triage",
			"--dangerously-skip-permissions",
			"--max-budget-usd",
			String(MAX_BUDGET_USD),
			"--no-session-persistence",
			"--output-format",
			"stream-json",
			"--verbose",
			"--worktree",
		],
		{
			cwd: PROJECT_DIR,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	// Watchdog: stdout が一定時間途絶えたらプロセスを強制終了
	let lastOutputAt = Date.now();
	let stalled = false;
	const watchdog = setInterval(() => {
		if (Date.now() - lastOutputAt > STALL_TIMEOUT_MS) {
			stalled = true;
			tee(
				`[${formatTimestamp()}] watchdog: no output for ${String(STALL_TIMEOUT_MS / 60000)}min, killing claude (pid: ${String(proc.pid)})`,
				logFile,
			);
			proc.kill("SIGTERM");
			// SIGTERM が無視された場合に備え、10 秒後に SIGKILL で強制終了
			setTimeout(() => {
				try {
					// プロセス生存チェック（signal 0 は kill せず存在確認のみ）
					process.kill(proc.pid, 0);
					tee(`[${formatTimestamp()}] watchdog: SIGTERM ignored, sending SIGKILL`, logFile);
					proc.kill("SIGKILL");
				} catch {
					// already dead
				}
			}, 10_000);
			clearInterval(watchdog);
		}
	}, 60_000);

	// stderr → logFile に追記（バックグラウンド）
	const stderrDone = (async () => {
		for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
			appendFileSync(logFile, new TextDecoder().decode(chunk));
		}
	})();

	// stdout をストリーミング処理（jq パイプ相当）
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
		lastOutputAt = Date.now();
		buffer += decoder.decode(chunk, { stream: true });
		let newlineIdx: number;
		while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIdx);
			buffer = buffer.slice(newlineIdx + 1);
			if (!line) continue;

			// jsonl ログにそのまま書き込み
			appendFileSync(jsonLog, `${line}\n`);

			// assistant テキストを抽出して表示
			for (const text of extractAssistantText(line)) {
				tee(text, logFile);
			}
		}
	}
	// TextDecoder の内部バッファをフラッシュし、残余データを処理
	buffer += decoder.decode();
	if (buffer) {
		appendFileSync(jsonLog, `${buffer}\n`);
		for (const text of extractAssistantText(buffer)) {
			tee(text, logFile);
		}
	}

	clearInterval(watchdog);
	await stderrDone;
	const exitCode = await proc.exited;
	const suffix = stalled ? " (killed by watchdog)" : "";
	tee(`[${formatTimestamp()}] auto-triage finished (exit: ${String(exitCode)})${suffix}`, logFile);
	return exitCode;
}

async function main(): Promise<void> {
	mkdirSync(LOG_DIR, { recursive: true });

	const hours = INTERVAL_SEC / 3600;
	console.log(`auto-triage loop: every ${String(INTERVAL_SEC)}s (${String(hours)}h)`);
	console.log(`logs: ${LOG_DIR}/`);
	console.log(`pid: ${String(process.pid)}`);
	console.log("---");

	for (;;) {
		try {
			// eslint-disable-next-line no-await-in-loop -- intentional sequential loop
			await runOnce();
		} catch (err) {
			console.error(
				`[${formatTimestamp()}] run failed: ${err instanceof Error ? err.message : String(err)}, continuing...`,
			);
		}

		const nextTime = new Date(Date.now() + INTERVAL_SEC * 1000);
		const next = nextTime.toLocaleTimeString("ja-JP", {
			hour: "2-digit",
			minute: "2-digit",
		});
		console.log(`next run in ${String(INTERVAL_SEC)}s (${next})`);
		// eslint-disable-next-line no-await-in-loop -- intentional sequential loop
		await Bun.sleep(INTERVAL_SEC * 1000);
	}
}

if (import.meta.main) {
	await main();
}
