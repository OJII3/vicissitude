import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface JunitTotals {
	tests: number;
	assertions: number;
	failures: number;
	skipped: number;
	timeSeconds: number;
}

interface FileTiming {
	file: string;
	tests: number;
	failures: number;
	timeSeconds: number;
}

interface CoverageFileSummary {
	file: string;
	linesFound: number;
	linesHit: number;
	functionsFound: number;
	functionsHit: number;
}

interface CoverageTotals {
	linesFound: number;
	linesHit: number;
	functionsFound: number;
	functionsHit: number;
}

interface TestQualitySummary {
	generatedAt: string;
	junitPath?: string;
	lcovPath?: string;
	flake?: {
		junitPath: string;
		rerunEach: number;
		testsAnalyzed: number;
		flakyTests: number;
		flakeRate: number | null;
		flakyFiles: Array<{
			file: string;
			flakyTests: number;
			totalTests: number;
			flakeRate: number | null;
		}>;
		flakyTestCases: Array<{
			file: string;
			name: string;
			line: string;
			passes: number;
			failures: number;
		}>;
	};
	tests?: {
		total: number;
		assertions: number;
		failures: number;
		skipped: number;
		failureRate: number;
		passRate: number;
		durationSeconds: number;
	};
	coverage?: {
		linesFound: number;
		linesHit: number;
		lineCoverage: number | null;
		functionsFound: number;
		functionsHit: number;
		functionCoverage: number | null;
	};
	slowestFiles: FileTiming[];
	lowestCoverageFiles: Array<CoverageFileSummary & { lineCoverage: number | null }>;
}

const ARTIFACT_DIR = resolve("artifacts/test-quality");
const DEFAULT_SUMMARY_JSON_PATH = resolve(ARTIFACT_DIR, "summary.json");
const DEFAULT_SUMMARY_MD_PATH = resolve(ARTIFACT_DIR, "summary.md");
const DEFAULT_HISTORY_NDJSON_PATH = resolve(ARTIFACT_DIR, "history.ndjson");

function parseArgs(argv: string[]): {
	junitPath?: string;
	lcovPath?: string;
	summaryJsonPath: string;
	summaryMdPath: string;
	historyNdjsonPath: string;
	flakeJunitPath?: string;
	flakeRuns?: number;
} {
	const result: {
		junitPath?: string;
		lcovPath?: string;
		summaryJsonPath: string;
		summaryMdPath: string;
		historyNdjsonPath: string;
		flakeJunitPath?: string;
		flakeRuns?: number;
	} = {
		summaryJsonPath: DEFAULT_SUMMARY_JSON_PATH,
		summaryMdPath: DEFAULT_SUMMARY_MD_PATH,
		historyNdjsonPath: DEFAULT_HISTORY_NDJSON_PATH,
	};
	for (const arg of argv) {
		if (arg.startsWith("--junit=")) {
			result.junitPath = resolve(arg.slice("--junit=".length));
			continue;
		}
		if (arg.startsWith("--lcov=")) {
			result.lcovPath = resolve(arg.slice("--lcov=".length));
			continue;
		}
		if (arg.startsWith("--summary-json=")) {
			result.summaryJsonPath = resolve(arg.slice("--summary-json=".length));
			continue;
		}
		if (arg.startsWith("--summary-md=")) {
			result.summaryMdPath = resolve(arg.slice("--summary-md=".length));
			continue;
		}
		if (arg.startsWith("--history-ndjson=")) {
			result.historyNdjsonPath = resolve(arg.slice("--history-ndjson=".length));
			continue;
		}
		if (arg.startsWith("--flake-junit=")) {
			result.flakeJunitPath = resolve(arg.slice("--flake-junit=".length));
			continue;
		}
		if (arg.startsWith("--flake-runs=")) {
			const runs = Number(arg.slice("--flake-runs=".length));
			if (Number.isInteger(runs) && runs >= 2) result.flakeRuns = runs;
		}
	}
	return result;
}

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function parseAttributes(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of tag.matchAll(/(\w+)="([^"]*)"/g)) {
		const [, key, value] = match;
		if (key && value !== undefined) attrs[key] = value;
	}
	return attrs;
}

function parseNumber(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function safeRate(hit: number, found: number): number | null {
	if (found <= 0) return null;
	return hit / found;
}

function parseJunit(xml: string): { totals: JunitTotals; fileTimings: FileTiming[] } {
	const rootMatch = xml.match(/<testsuites\b([^>]*)>/);
	if (!rootMatch) {
		throw new Error("JUnit XML に <testsuites> が見つかりません");
	}

	const rootAttrs = parseAttributes(rootMatch[1] ?? "");
	const totals: JunitTotals = {
		tests: parseNumber(rootAttrs.tests),
		assertions: parseNumber(rootAttrs.assertions),
		failures: parseNumber(rootAttrs.failures),
		skipped: parseNumber(rootAttrs.skipped),
		timeSeconds: parseNumber(rootAttrs.time),
	};

	const fileTimingsByFile = new Map<string, FileTiming>();
	for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
		const attrs = parseAttributes(match[1] ?? "");
		if (!attrs.file || attrs.name !== attrs.file) continue;
		fileTimingsByFile.set(attrs.file, {
			file: attrs.file,
			tests: 0,
			failures: 0,
			timeSeconds: 0,
		});
	}

	for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const attrs = parseAttributes(match[1] ?? "");
		const body = match[2] ?? "";
		if (!attrs.file) continue;
		const existing = fileTimingsByFile.get(attrs.file) ?? {
			file: attrs.file,
			tests: 0,
			failures: 0,
			timeSeconds: 0,
		};
		existing.tests += 1;
		existing.timeSeconds += parseNumber(attrs.time);
		if (body.includes("<failure")) {
			existing.failures += 1;
		}
		fileTimingsByFile.set(attrs.file, existing);
	}

	const fileTimings = [...fileTimingsByFile.values()];
	fileTimings.sort((a, b) => b.timeSeconds - a.timeSeconds || a.file.localeCompare(b.file));
	return { totals, fileTimings };
}

function parseFlakeSummary(
	xml: string,
	rerunEach: number,
	flakeJunitPath: string,
): NonNullable<TestQualitySummary["flake"]> {
	const testCaseRuns = new Map<
		string,
		{ file: string; name: string; line: string; passes: number; failures: number }
	>();

	for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const attrs = parseAttributes(match[1] ?? "");
		const body = match[2] ?? "";
		if (!attrs.file || !attrs.name) continue;
		const line = attrs.line ?? "0";
		const key = `${attrs.file}:${line}:${attrs.name}`;
		const existing = testCaseRuns.get(key) ?? {
			file: attrs.file,
			name: attrs.name,
			line,
			passes: 0,
			failures: 0,
		};
		if (body.includes("<failure")) {
			existing.failures += 1;
		} else {
			existing.passes += 1;
		}
		testCaseRuns.set(key, existing);
	}

	const summarizedRuns = [...testCaseRuns.values()];
	const flakyTests = summarizedRuns.filter((test) => test.passes > 0 && test.failures > 0);
	const fileCounts = new Map<string, { flakyTests: number; totalTests: number }>();
	for (const test of summarizedRuns) {
		const current = fileCounts.get(test.file) ?? { flakyTests: 0, totalTests: 0 };
		current.totalTests += 1;
		if (test.passes > 0 && test.failures > 0) current.flakyTests += 1;
		fileCounts.set(test.file, current);
	}

	return {
		junitPath: flakeJunitPath,
		rerunEach,
		testsAnalyzed: summarizedRuns.length,
		flakyTests: flakyTests.length,
		flakeRate: safeRate(flakyTests.length, summarizedRuns.length),
		flakyFiles: [...fileCounts.entries()]
			.map(([file, counts]) => ({
				file,
				flakyTests: counts.flakyTests,
				totalTests: counts.totalTests,
				flakeRate: safeRate(counts.flakyTests, counts.totalTests),
			}))
			.filter((file) => file.flakyTests > 0)
			.toSorted(
				(a, b) =>
					b.flakyTests - a.flakyTests ||
					(b.flakeRate ?? 0) - (a.flakeRate ?? 0) ||
					a.file.localeCompare(b.file),
			)
			.slice(0, 10),
		flakyTestCases: flakyTests
			.toSorted(
				(a, b) =>
					b.failures - a.failures ||
					b.passes - a.passes ||
					a.file.localeCompare(b.file) ||
					a.name.localeCompare(b.name),
			)
			.slice(0, 10),
	};
}

function parseLcov(lcov: string): { totals: CoverageTotals; files: CoverageFileSummary[] } {
	const files: CoverageFileSummary[] = [];
	let current: Partial<CoverageFileSummary> = {};

	function finishCurrent(): void {
		if (!current.file) return;
		files.push({
			file: current.file,
			linesFound: current.linesFound ?? 0,
			linesHit: current.linesHit ?? 0,
			functionsFound: current.functionsFound ?? 0,
			functionsHit: current.functionsHit ?? 0,
		});
		current = {};
	}

	for (const rawLine of lcov.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (line === "end_of_record") {
			finishCurrent();
			continue;
		}
		if (line.startsWith("SF:")) {
			current.file = line.slice(3);
			continue;
		}
		if (line.startsWith("LF:")) {
			current.linesFound = parseNumber(line.slice(3));
			continue;
		}
		if (line.startsWith("LH:")) {
			current.linesHit = parseNumber(line.slice(3));
			continue;
		}
		if (line.startsWith("FNF:")) {
			current.functionsFound = parseNumber(line.slice(4));
			continue;
		}
		if (line.startsWith("FNH:")) {
			current.functionsHit = parseNumber(line.slice(4));
		}
	}
	finishCurrent();

	const totals = files.reduce<CoverageTotals>(
		(acc, file) => {
			acc.linesFound += file.linesFound;
			acc.linesHit += file.linesHit;
			acc.functionsFound += file.functionsFound;
			acc.functionsHit += file.functionsHit;
			return acc;
		},
		{ linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 },
	);

	return { totals, files };
}

function formatPercent(value: number | null): string {
	if (value === null) return "n/a";
	return `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(summary: TestQualitySummary): string {
	const lines = ["# Test Quality Summary", "", `- Generated: ${summary.generatedAt}`];

	if (summary.tests && summary.coverage) {
		lines.push(
			`- Tests: ${String(summary.tests.total)} total / ${String(summary.tests.failures)} fail / ${String(summary.tests.skipped)} skipped`,
			`- Assertions: ${String(summary.tests.assertions)}`,
			`- Failure rate: ${formatPercent(summary.tests.failureRate)}`,
			`- Pass rate: ${formatPercent(summary.tests.passRate)}`,
			`- Duration: ${summary.tests.durationSeconds.toFixed(3)}s`,
			`- Line coverage: ${formatPercent(summary.coverage.lineCoverage)} (${String(summary.coverage.linesHit)}/${String(summary.coverage.linesFound)})`,
			`- Function coverage: ${formatPercent(summary.coverage.functionCoverage)} (${String(summary.coverage.functionsHit)}/${String(summary.coverage.functionsFound)})`,
			"",
			"## Slowest Test Files",
			"",
		);

		if (summary.slowestFiles.length === 0) {
			lines.push("- none");
		} else {
			for (const file of summary.slowestFiles) {
				lines.push(
					`- ${file.file}: ${file.timeSeconds.toFixed(3)}s, tests=${String(file.tests)}, failures=${String(file.failures)}`,
				);
			}
		}

		lines.push("", "## Lowest Line Coverage Files", "");
		if (summary.lowestCoverageFiles.length === 0) {
			lines.push("- none");
		} else {
			for (const file of summary.lowestCoverageFiles) {
				lines.push(
					`- ${file.file}: ${formatPercent(file.lineCoverage)} (${String(file.linesHit)}/${String(file.linesFound)})`,
				);
			}
		}
	}

	if (summary.flake) {
		lines.push("", "## Flake Summary", "");
		lines.push(`- Rerun each: ${String(summary.flake.rerunEach)}`);
		lines.push(`- Tests analyzed: ${String(summary.flake.testsAnalyzed)}`);
		lines.push(`- Flaky tests: ${String(summary.flake.flakyTests)}`);
		lines.push(`- Flake rate: ${formatPercent(summary.flake.flakeRate)}`);
		lines.push("", "### Flaky Files", "");
		if (summary.flake.flakyFiles.length === 0) {
			lines.push("- none");
		} else {
			for (const file of summary.flake.flakyFiles) {
				lines.push(
					`- ${file.file}: ${String(file.flakyTests)}/${String(file.totalTests)} (${formatPercent(file.flakeRate)})`,
				);
			}
		}

		lines.push("", "### Flaky Test Cases", "");
		if (summary.flake.flakyTestCases.length === 0) {
			lines.push("- none");
		} else {
			for (const test of summary.flake.flakyTestCases) {
				lines.push(
					`- ${test.file}:${test.line} ${test.name}: pass=${String(test.passes)}, fail=${String(test.failures)}`,
				);
			}
		}
	}

	return `${lines.join("\n")}\n`;
}

function renderStructuredLog(summary: TestQualitySummary): string {
	return JSON.stringify({
		timestamp: summary.generatedAt,
		component: "test-quality",
		mode: summary.flake ? "flake" : "quality",
		kind: "summary",
		tests_total: summary.tests?.total,
		assertions_total: summary.tests?.assertions,
		failures_total: summary.tests?.failures,
		skipped_total: summary.tests?.skipped,
		failure_rate: summary.tests?.failureRate,
		pass_rate: summary.tests?.passRate,
		duration_seconds: summary.tests?.durationSeconds,
		line_coverage: summary.coverage?.lineCoverage,
		function_coverage: summary.coverage?.functionCoverage,
		flaky_tests: summary.flake?.flakyTests,
		flake_rate: summary.flake?.flakeRate,
		rerun_each: summary.flake?.rerunEach,
		slowest_file: summary.slowestFiles[0]?.file,
		lowest_coverage_file: summary.lowestCoverageFiles[0]?.file,
	});
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	let fileTimings: FileTiming[] = [];
	let coverageFiles: Array<CoverageFileSummary & { lineCoverage: number | null }> = [];

	const summary: TestQualitySummary = {
		generatedAt: new Date().toISOString(),
		junitPath: args.junitPath,
		lcovPath: args.lcovPath,
		slowestFiles: [],
		lowestCoverageFiles: [],
	};

	if (args.junitPath && args.lcovPath && existsSync(args.junitPath) && existsSync(args.lcovPath)) {
		const junitXml = readText(args.junitPath);
		const lcovText = readText(args.lcovPath);
		const { totals, fileTimings: parsedFileTimings } = parseJunit(junitXml);
		const { totals: coverageTotals, files: parsedCoverageFiles } = parseLcov(lcovText);

		fileTimings = parsedFileTimings;
		coverageFiles = parsedCoverageFiles
			.map((file) =>
				Object.assign({}, file, {
					lineCoverage: safeRate(file.linesHit, file.linesFound),
				}),
			)
			.filter((file) => file.linesFound > 0)
			.toSorted((a, b) => {
				const left = a.lineCoverage ?? 1;
				const right = b.lineCoverage ?? 1;
				return left - right || b.linesFound - a.linesFound || a.file.localeCompare(b.file);
			});

		summary.tests = {
			total: totals.tests,
			assertions: totals.assertions,
			failures: totals.failures,
			skipped: totals.skipped,
			failureRate: safeRate(totals.failures, totals.tests) ?? 0,
			passRate: safeRate(totals.tests - totals.failures - totals.skipped, totals.tests) ?? 0,
			durationSeconds: totals.timeSeconds,
		};
		summary.coverage = {
			linesFound: coverageTotals.linesFound,
			linesHit: coverageTotals.linesHit,
			lineCoverage: safeRate(coverageTotals.linesHit, coverageTotals.linesFound),
			functionsFound: coverageTotals.functionsFound,
			functionsHit: coverageTotals.functionsHit,
			functionCoverage: safeRate(coverageTotals.functionsHit, coverageTotals.functionsFound),
		};
		summary.slowestFiles = fileTimings.slice(0, 10);
		summary.lowestCoverageFiles = coverageFiles.slice(0, 10);
	}

	if (args.flakeJunitPath && args.flakeRuns) {
		summary.flake = parseFlakeSummary(
			readText(args.flakeJunitPath),
			args.flakeRuns,
			args.flakeJunitPath,
		);
	}

	mkdirSync(dirname(args.summaryJsonPath), { recursive: true });
	writeFileSync(args.summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
	writeFileSync(args.summaryMdPath, renderMarkdown(summary));

	const structuredLog = renderStructuredLog(summary);
	appendFileSync(args.historyNdjsonPath, `${structuredLog}\n`);
	console.log(renderMarkdown(summary).trimEnd());
	console.log(structuredLog);
}

if (import.meta.main) {
	main();
}

export { parseArgs, parseJunit, parseLcov };
