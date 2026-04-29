import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { extractCodexAssistantText, formatTimestamp, tee } from "./lib/loop-runner";

const PROJECT_DIR = resolve(import.meta.dirname, "..");
const RUNNER_NAME = "auto-triage-codex";
const LOG_DIR = resolve(PROJECT_DIR, "logs", RUNNER_NAME);
const WORKTREE_DIR = resolve(PROJECT_DIR, ".codex/worktrees");
/** 1 hour */
const INTERVAL_SEC = 1 * 60 * 60;
/** 30 minutes — kill codex if no stdout output for this duration */
const STALL_TIMEOUT_MS = 30 * 60 * 1000;
const PROMPT = [
	"auto-triage スキルを使用して、GitHub Issue または main の CI 失敗を 1 件だけ処理してください。",
	"必ず .claude/skills/auto-triage/SKILL.md と AGENTS.md の指示に従ってください。",
	"このセッションは専用 git worktree 上で起動されています。main に直接コミットしないでください。",
].join("\n");

/** gh issue list から help wanted を除いた issue があるか、または CI が失敗しているかを返す */
async function hasWork(): Promise<{ hasCiFailure: boolean; hasIssue: boolean }> {
	const ciProc = Bun.spawn(
		["gh", "run", "list", "--branch", "main", "--limit", "5", "--json", "conclusion"],
		{ cwd: PROJECT_DIR, stdout: "pipe", stderr: "ignore" },
	);
	const ciOut = await new Response(ciProc.stdout).text();
	await ciProc.exited;

	let hasCiFailure = false;
	try {
		const runs = JSON.parse(ciOut) as { conclusion: string }[];
		hasCiFailure = runs.some((r) => r.conclusion === "failure");
	} catch {
		// gh コマンド失敗時は安全側に倒して Codex に任せる
		hasCiFailure = true;
	}

	const issueProc = Bun.spawn(
		[
			"gh",
			"issue",
			"list",
			"--state",
			"open",
			"--search",
			'-label:"help wanted"',
			"--limit",
			"1",
			"--json",
			"number",
		],
		{ cwd: PROJECT_DIR, stdout: "pipe", stderr: "ignore" },
	);
	const issueOut = await new Response(issueProc.stdout).text();
	await issueProc.exited;

	let hasIssue = false;
	try {
		const issues = JSON.parse(issueOut) as { number: number }[];
		hasIssue = issues.length > 0;
	} catch {
		hasIssue = true;
	}

	return { hasCiFailure, hasIssue };
}

async function prepareWorktree(timestamp: string, logFile: string): Promise<string> {
	mkdirSync(WORKTREE_DIR, { recursive: true });

	const fetchProc = Bun.spawn(["git", "fetch", "origin", "main"], {
		cwd: PROJECT_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [fetchStdout, fetchStderr] = await Promise.all([
		new Response(fetchProc.stdout).text(),
		new Response(fetchProc.stderr).text(),
	]);
	const fetchExitCode = await fetchProc.exited;
	tee((fetchStdout + fetchStderr).trimEnd(), logFile);
	if (fetchExitCode !== 0) {
		tee(
			`[WARN] git fetch origin main failed (exit: ${String(fetchExitCode)}); using local main`,
			logFile,
		);
	}

	const branch = `auto/codex-triage-${timestamp}`;
	const worktreePath = resolve(WORKTREE_DIR, timestamp);
	const baseRef = fetchExitCode === 0 ? "origin/main" : "main";
	const addProc = Bun.spawn(["git", "worktree", "add", "-B", branch, worktreePath, baseRef], {
		cwd: PROJECT_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [addStdout, addStderr] = await Promise.all([
		new Response(addProc.stdout).text(),
		new Response(addProc.stderr).text(),
	]);
	const addExitCode = await addProc.exited;
	tee((addStdout + addStderr).trimEnd(), logFile);
	if (addExitCode !== 0) {
		throw new Error(`git worktree add failed (exit: ${String(addExitCode)})`);
	}

	return worktreePath;
}

async function runOnce(): Promise<number> {
	const timestamp = formatTimestamp();
	const logFile = resolve(LOG_DIR, `${timestamp}.log`);
	const jsonLog = resolve(LOG_DIR, `${timestamp}.jsonl`);

	tee(`[${timestamp}] ${RUNNER_NAME} starting`, logFile);

	const { hasCiFailure, hasIssue } = await hasWork();
	if (!hasCiFailure && !hasIssue) {
		tee(`[${timestamp}] no work found (CI green, no actionable issues), skipping`, logFile);
		return 0;
	}
	tee(
		`[${timestamp}] work found: CI failure=${String(hasCiFailure)}, actionable issues=${String(hasIssue)}`,
		logFile,
	);

	const worktreePath = await prepareWorktree(timestamp, logFile);
	tee(`[${timestamp}] launching codex in ${worktreePath}`, logFile);

	const proc = Bun.spawn(
		[
			"codex",
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--cd",
			worktreePath,
			"--ephemeral",
			"--json",
			PROMPT,
		],
		{
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	let lastOutputAt = Date.now();
	let stalled = false;
	const watchdog = setInterval(() => {
		if (Date.now() - lastOutputAt > STALL_TIMEOUT_MS) {
			stalled = true;
			tee(
				`[${formatTimestamp()}] watchdog: no output for ${String(STALL_TIMEOUT_MS / 60000)}min, killing codex (pid: ${String(proc.pid)})`,
				logFile,
			);
			proc.kill("SIGTERM");
			setTimeout(() => {
				try {
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

	const stderrDone = (async () => {
		for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
			appendFileSync(logFile, new TextDecoder().decode(chunk));
		}
	})();

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

			appendFileSync(jsonLog, `${line}\n`);

			for (const text of extractCodexAssistantText(line)) {
				tee(text, logFile);
			}
		}
	}

	buffer += decoder.decode();
	if (buffer) {
		appendFileSync(jsonLog, `${buffer}\n`);
		for (const text of extractCodexAssistantText(buffer)) {
			tee(text, logFile);
		}
	}

	clearInterval(watchdog);
	await stderrDone;
	const exitCode = await proc.exited;
	const suffix = stalled ? " (killed by watchdog)" : "";
	tee(
		`[${formatTimestamp()}] ${RUNNER_NAME} finished (exit: ${String(exitCode)})${suffix}`,
		logFile,
	);

	await cleanupWorktrees(logFile);

	return exitCode;
}

/** マージ済み or 不要な worktree を削除する */
async function cleanupWorktrees(logFile: string): Promise<void> {
	const listProc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
		cwd: PROJECT_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	const listOut = await new Response(listProc.stdout).text();
	await listProc.exited;

	const worktrees: { path: string; branch: string }[] = [];
	for (const block of listOut.split("\n\n")) {
		const pathMatch = block.match(/^worktree (.+)$/m);
		const branchMatch = block.match(/^branch (.+)$/m);
		if (pathMatch?.[1] && branchMatch?.[1]) {
			worktrees.push({ path: pathMatch[1], branch: branchMatch[1] });
		}
	}

	const targets = worktrees.filter((w) => w.path.startsWith(WORKTREE_DIR));

	let cleaned = 0;
	for (const wt of targets) {
		const removeProc = Bun.spawn(["git", "worktree", "remove", "--force", wt.path], {
			cwd: PROJECT_DIR,
			stdout: "pipe",
			stderr: "pipe",
		});
		// eslint-disable-next-line no-await-in-loop -- worktree 削除は順次実行が安全
		const removeErr = await new Response(removeProc.stderr).text();
		// eslint-disable-next-line no-await-in-loop -- 同上
		const removeExit = await removeProc.exited;
		if (removeExit === 0) {
			cleaned++;
			const shortBranch = wt.branch.replace("refs/heads/", "");
			Bun.spawn(["git", "branch", "-D", shortBranch], {
				cwd: PROJECT_DIR,
				stdout: "ignore",
				stderr: "ignore",
			});
		} else if (removeErr.includes("dirty")) {
			tee(`[cleanup] skipped (dirty): ${wt.path}`, logFile);
		}
	}

	if (cleaned > 0) {
		tee(`[cleanup] removed ${String(cleaned)} worktree(s)`, logFile);
	}
}

async function main(): Promise<void> {
	mkdirSync(LOG_DIR, { recursive: true });

	const hours = INTERVAL_SEC / 3600;
	console.log(`${RUNNER_NAME} loop: every ${String(INTERVAL_SEC)}s (${String(hours)}h)`);
	console.log(`logs: ${LOG_DIR}/`);
	console.log(`pid: ${String(process.pid)}`);
	console.log("---");

	if (process.argv.includes("--once")) {
		process.exitCode = await runOnce();
		return;
	}

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
