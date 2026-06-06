import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	classifyBareInstanceState,
	isPidRunning,
	parseBareInstanceArgs,
	readBareInstanceState,
	resolveBareControlPaths,
} from "./bare-instance.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("bare-instance", () => {
	test("parseBareInstanceArgs は subcommand を解釈する", () => {
		const parsed = parseBareInstanceArgs(["start", "--foo"]);
		expect(parsed.command).toBe("start");
		expect(parsed.args).toEqual(["--foo"]);
	});

	test("resolveBareControlPaths は XDG_DATA_HOME 配下を使う", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-control-"));
		const paths = resolveBareControlPaths({
			HOME: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		expect(paths.instanceDir).toBe(join(tempDir, "xdg-data", "vicissitude", "bare-instance"));
		expect(paths.logFile).toBe(join(tempDir, "xdg-data", "vicissitude", "logs", "bare.log"));
	});

	test("readBareInstanceState は state file を読む", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-state-"));
		const paths = resolveBareControlPaths({
			HOME: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		mkdirSync(paths.instanceDir, { recursive: true });
		writeFileSync(
			paths.stateFile,
			JSON.stringify({
				pid: 123,
				appRoot: "/repo",
				logPath: "/tmp/bare.log",
				startedAt: "2026-06-05T00:00:00.000Z",
				command: "run",
			}),
		);

		expect(readBareInstanceState(paths)?.pid).toBe(123);
	});

	test("classifyBareInstanceState は state file がなければ stopped", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-status-"));
		const paths = resolveBareControlPaths({
			HOME: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		expect(classifyBareInstanceState(paths, null)).toBe("stopped");
	});

	test("classifyBareInstanceState は lock だけ残っていれば stale", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vicissitude-bare-stale-"));
		const paths = resolveBareControlPaths({
			HOME: tempDir,
			XDG_DATA_HOME: join(tempDir, "xdg-data"),
		});
		mkdirSync(paths.lockDir, { recursive: true });
		expect(classifyBareInstanceState(paths, null)).toBe("stale");
	});

	test("isPidRunning は現在プロセスを running と判定する", () => {
		expect(isPidRunning(process.pid)).toBe(true);
	});
});
