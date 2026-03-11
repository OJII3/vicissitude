import { describe, expect, test } from "bun:test";

import { resolveExitCode as resolveFlakeExitCode } from "./test-quality-flake.ts";
import { parseArgs, parseJunit } from "./test-quality-report.ts";
import { resolveExitCode as resolveQualityExitCode } from "./test-quality.ts";

describe("parseJunit", () => {
	test("testsuite failures と testcase failure を二重計上しない", () => {
		const xml = `
			<testsuites tests="2" assertions="2" failures="1" skipped="0" time="0.3">
				<testsuite name="src/example.test.ts" file="src/example.test.ts" tests="2" failures="1" time="0.3">
					<testcase name="pass" file="src/example.test.ts" line="1" time="0.1" />
					<testcase name="fail" file="src/example.test.ts" line="2" time="0.2">
						<failure message="boom">boom</failure>
					</testcase>
				</testsuite>
			</testsuites>
		`;

		const { totals, fileTimings } = parseJunit(xml);

		expect(totals.failures).toBe(1);
		expect(fileTimings).toHaveLength(1);
		expect(fileTimings[0]?.failures).toBe(1);
		expect(fileTimings[0]?.tests).toBe(2);
	});
});

describe("parseArgs", () => {
	test("flake 専用実行では通常 junit/lcov を暗黙参照しない", () => {
		const args = parseArgs([
			"--flake-junit=artifacts/test-quality/junit-flake.xml",
			"--flake-runs=5",
			"--summary-json=artifacts/test-quality/summary-flake.json",
			"--summary-md=artifacts/test-quality/summary-flake.md",
		]);

		expect(args.junitPath).toBeUndefined();
		expect(args.lcovPath).toBeUndefined();
		expect(args.flakeJunitPath).toContain("junit-flake.xml");
		expect(args.flakeRuns).toBe(5);
	});
});

describe("resolveExitCode", () => {
	test("通常実行ではテスト失敗を優先する", () => {
		expect(resolveQualityExitCode(1, 0)).toBe(1);
		expect(resolveQualityExitCode(0, 1)).toBe(1);
		expect(resolveQualityExitCode(0, 0)).toBe(0);
	});

	test("flake 実行でもテスト失敗を優先する", () => {
		expect(resolveFlakeExitCode(1, 0)).toBe(1);
		expect(resolveFlakeExitCode(0, 1)).toBe(1);
		expect(resolveFlakeExitCode(0, 0)).toBe(0);
	});
});
