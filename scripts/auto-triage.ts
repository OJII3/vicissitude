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

/** gh issue list から help wanted を除いた issue があるか、または CI が失敗しているかを返す */
async function hasWork(): Promise<{ hasCiFailure: boolean; hasIssue: boolean }> {
	// CI 失敗チェック
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
		// gh コマンド失敗時は安全側に倒して claude に任せる
		hasCiFailure = true;
	}

	// help wanted を除いた open issue があるかチェック
	const [allProc, hwProc] = [
		Bun.spawn(["gh", "issue", "list", "--state", "open", "--limit", "20", "--json", "number"], {
			cwd: PROJECT_DIR,
			stdout: "pipe",
			stderr: "ignore",
		}),
		Bun.spawn(
			[
				"gh",
				"issue",
				"list",
				"--state",
				"open",
				"--label",
				"help wanted",
				"--limit",
				"20",
				"--json",
				"number",
			],
			{ cwd: PROJECT_DIR, stdout: "pipe", stderr: "ignore" },
		),
	];

	const [allOut, hwOut] = await Promise.all([
		new Response(allProc.stdout).text(),
		new Response(hwProc.stdout).text(),
	]);
	await Promise.all([allProc.exited, hwProc.exited]);

	let hasIssue = false;
	try {
		const all = new Set((JSON.parse(allOut) as { number: number }[]).map((i) => i.number));
		const hw = new Set((JSON.parse(hwOut) as { number: number }[]).map((i) => i.number));
		// help wanted を除外した残りがあるか
		hasIssue = [...all].some((n) => !hw.has(n));
	} catch {
		// gh コマンド失敗時は安全側に倒す
		hasIssue = true;
	}

	return { hasCiFailure, hasIssue };
}

async function runOnce(): Promise<number> {
	const timestamp = formatTimestamp();
	const logFile = resolve(LOG_DIR, `${timestamp}.log`);
	const jsonLog = resolve(LOG_DIR, `${timestamp}.jsonl`);

	tee(`[${timestamp}] auto-triage starting`, logFile);

	// 事前チェック: claude を起動する必要があるか判定
	const { hasCiFailure, hasIssue } = await hasWork();
	if (!hasCiFailure && !hasIssue) {
		tee(`[${timestamp}] no work found (CI green, no actionable issues), skipping`, logFile);
		return 0;
	}
	tee(
		`[${timestamp}] work found: CI failure=${String(hasCiFailure)}, actionable issues=${String(hasIssue)}`,
		logFile,
	);

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

	// porcelain 形式: "worktree <path>\nHEAD <sha>\nbranch <ref>\n\n" のブロック
	const worktrees: { path: string; branch: string }[] = [];
	for (const block of listOut.split("\n\n")) {
		const pathMatch = block.match(/^worktree (.+)$/m);
		const branchMatch = block.match(/^branch (.+)$/m);
		if (pathMatch?.[1] && branchMatch?.[1]) {
			worktrees.push({ path: pathMatch[1], branch: branchMatch[1] });
		}
	}

	// メインリポジトリは除外、.claude/worktrees/ 配下のみ対象
	const worktreeDir = resolve(PROJECT_DIR, ".claude/worktrees");
	const targets = worktrees.filter((w) => w.path.startsWith(worktreeDir));

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
			// worktree 用に作られたローカルブランチも削除
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
