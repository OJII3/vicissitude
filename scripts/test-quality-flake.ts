import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_DIR = resolve("artifacts/test-quality");
const FLAKE_JUNIT_PATH = resolve(ARTIFACT_DIR, "junit-flake.xml");
const FLAKE_SUMMARY_JSON_PATH = resolve(ARTIFACT_DIR, "summary-flake.json");
const FLAKE_SUMMARY_MD_PATH = resolve(ARTIFACT_DIR, "summary-flake.md");
const DEFAULT_RERUN_EACH = 5;

function parseRerunEach(): number {
	const raw = process.env.TEST_FLAKE_RUNS;
	if (!raw) return DEFAULT_RERUN_EACH;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 2 ? parsed : DEFAULT_RERUN_EACH;
}

async function main(): Promise<void> {
	mkdirSync(ARTIFACT_DIR, { recursive: true });

	const rerunEach = parseRerunEach();
	const testProc = Bun.spawn(
		[
			"bun",
			"test",
			`--rerun-each=${String(rerunEach)}`,
			"--reporter=junit",
			`--reporter-outfile=${FLAKE_JUNIT_PATH}`,
		],
		{
			stdout: "inherit",
			stderr: "inherit",
		},
	);

	const exitCode = await testProc.exited;
	if (exitCode !== 0) {
		console.error(
			`[test:quality:flake] bun test exited with code ${String(exitCode)}; summary-flake を確認してください`,
		);
	}

	const reportProc = Bun.spawn(
		[
			"bun",
			"scripts/test-quality-report.ts",
			`--flake-junit=${FLAKE_JUNIT_PATH}`,
			`--flake-runs=${String(rerunEach)}`,
			`--summary-json=${FLAKE_SUMMARY_JSON_PATH}`,
			`--summary-md=${FLAKE_SUMMARY_MD_PATH}`,
		],
		{
			stdout: "inherit",
			stderr: "inherit",
		},
	);

	const reportExitCode = await reportProc.exited;
	process.exitCode = reportExitCode;
}

await main();
