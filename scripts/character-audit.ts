/**
 * character-audit.ts — character-audit スキルのループラッパー。
 *
 * 半日ごとに claude -p /character-audit を実行し、
 * キャラクター一貫性の評価と Issue 起票を行う。
 *
 * auto-triage.ts と同じパターン: ログ出力・watchdog・定期実行。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_DIR = resolve(import.meta.dirname, "..");
const LOG_DIR = resolve(PROJECT_DIR, "logs/character-audit");
const MAX_BUDGET_USD = 5;
/** 12 hours */
const INTERVAL_SEC = 12 * 60 * 60;
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

/** extract-audit-data.ts を実行して、評価対象のエピソードがあるか確認する */
async function hasData(): Promise<boolean> {
	const proc = Bun.spawn(["bun", "scripts/extract-audit-data.ts"], {
		cwd: PROJECT_DIR,
		stdout: "pipe",
		stderr: "ignore",
	});
	const output = await new Response(proc.stdout).text();
	await proc.exited;

	try {
		const data = JSON.parse(output) as {
			namespaces: { episodes: unknown[] }[];
		};
		return data.namespaces.some((ns) => ns.episodes.length > 0);
	} catch {
		return false;
	}
}

async function runOnce(): Promise<number> {
	const timestamp = formatTimestamp();
	const logFile = resolve(LOG_DIR, `${timestamp}.log`);
	const jsonLog = resolve(LOG_DIR, `${timestamp}.jsonl`);

	tee(`[${timestamp}] character-audit starting`, logFile);

	// 事前チェック: エピソードがあるか
	const dataExists = await hasData();
	if (!dataExists) {
		tee(`[${timestamp}] no episodes found, skipping`, logFile);
		return 0;
	}
	tee(`[${timestamp}] episodes found, launching claude`, logFile);

	const proc = Bun.spawn(
		[
			"claude",
			"-p",
			"/character-audit",
			"--dangerously-skip-permissions",
			"--max-budget-usd",
			String(MAX_BUDGET_USD),
			"--no-session-persistence",
			"--output-format",
			"stream-json",
			"--verbose",
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

	// stderr → logFile に追記（バックグラウンド）
	const stderrDone = (async () => {
		for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
			appendFileSync(logFile, new TextDecoder().decode(chunk));
		}
	})();

	// stdout をストリーミング処理
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

			for (const text of extractAssistantText(line)) {
				tee(text, logFile);
			}
		}
	}
	// TextDecoder の内部バッファをフラッシュ
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
	tee(
		`[${formatTimestamp()}] character-audit finished (exit: ${String(exitCode)})${suffix}`,
		logFile,
	);

	return exitCode;
}

async function main(): Promise<void> {
	mkdirSync(LOG_DIR, { recursive: true });

	const hours = INTERVAL_SEC / 3600;
	console.log(`character-audit loop: every ${String(INTERVAL_SEC)}s (${String(hours)}h)`);
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
