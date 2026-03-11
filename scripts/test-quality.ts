import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_DIR = resolve("artifacts/test-quality");
const COVERAGE_DIR = resolve(ARTIFACT_DIR, "coverage");
const JUNIT_PATH = resolve(ARTIFACT_DIR, "junit.xml");
const LCOV_PATH = resolve(COVERAGE_DIR, "lcov.info");
const SUMMARY_JSON_PATH = resolve(ARTIFACT_DIR, "summary.json");
const SUMMARY_MD_PATH = resolve(ARTIFACT_DIR, "summary.md");

function resetArtifacts(): void {
	for (const path of [JUNIT_PATH, LCOV_PATH, SUMMARY_JSON_PATH, SUMMARY_MD_PATH]) {
		rmSync(path, { force: true });
	}
	mkdirSync(COVERAGE_DIR, { recursive: true });
}

function resolveExitCode(testExitCode: number, reportExitCode: number): number {
	return testExitCode === 0 ? reportExitCode : testExitCode;
}

async function main(): Promise<void> {
	resetArtifacts();

	const testProc = Bun.spawn(
		[
			"bun",
			"test",
			"--coverage",
			"--coverage-reporter=lcov",
			`--coverage-dir=${COVERAGE_DIR}`,
			"--reporter=junit",
			`--reporter-outfile=${JUNIT_PATH}`,
		],
		{
			stdout: "inherit",
			stderr: "inherit",
		},
	);

	const testExitCode = await testProc.exited;
	if (testExitCode !== 0) {
		console.error(
			`[test:quality] bun test exited with code ${String(testExitCode)}; summary を生成してから終了します`,
		);
	}

	const reportProc = Bun.spawn(
		[
			"bun",
			"scripts/test-quality-report.ts",
			`--junit=${JUNIT_PATH}`,
			`--lcov=${LCOV_PATH}`,
			`--summary-json=${SUMMARY_JSON_PATH}`,
			`--summary-md=${SUMMARY_MD_PATH}`,
		],
		{
			stdout: "inherit",
			stderr: "inherit",
		},
	);

	const reportExitCode = await reportProc.exited;
	process.exitCode = resolveExitCode(testExitCode, reportExitCode);
}

if (import.meta.main) {
	await main();
}

export { resolveExitCode };
