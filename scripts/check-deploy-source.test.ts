import { describe, expect, test } from "bun:test";

import {
	type CommandResult,
	getDeploySourceStatus,
	validateDeploySource,
} from "./check-deploy-source.ts";

function ok(stdout = ""): CommandResult {
	return { status: 0, stdout, stderr: "" };
}

function fail(stderr: string): CommandResult {
	return { status: 1, stdout: "", stderr };
}

describe("check-deploy-source", () => {
	test("main が origin/main と一致していれば問題なし", () => {
		const status = {
			branch: "main",
			head: "0123456789abcdef",
			remoteHead: "0123456789abcdef",
		};

		expect(validateDeploySource(status)).toEqual([]);
	});

	test("main 以外からの deploy を拒否する", () => {
		const problems = validateDeploySource({
			branch: "feature/example",
			head: "0123456789abcdef",
			remoteHead: "0123456789abcdef",
		});

		expect(problems.join("\n")).toContain("main ブランチ");
	});

	test("origin/main より古い checkout を拒否する", () => {
		const problems = validateDeploySource({
			branch: "main",
			head: "aaaaaaaaaaaaaaaa",
			remoteHead: "bbbbbbbbbbbbbbbb",
		});

		expect(problems.join("\n")).toContain("origin/main と一致していません");
		expect(problems.join("\n")).toContain("HEAD=aaaaaaa");
		expect(problems.join("\n")).toContain("origin/main=bbbbbbb");
	});

	test("git コマンド失敗は例外にする", () => {
		expect(() =>
			getDeploySourceStatus((command, args) => {
				if (command === "git" && args[0] === "fetch") return fail("network down");
				return ok("");
			}),
		).toThrow("network down");
	});

	test("git から deploy 元の状態を読み取る", () => {
		const outputs = new Map<string, CommandResult>([
			["git fetch origin main", ok("")],
			["git branch --show-current", ok("main\n")],
			["git rev-parse HEAD", ok("0123456789abcdef\n")],
			["git rev-parse origin/main", ok("0123456789abcdef\n")],
		]);

		const status = getDeploySourceStatus((command, args) => {
			const key = [command, ...args].join(" ");
			const result = outputs.get(key);
			if (!result) return fail(`unexpected command: ${key}`);
			return result;
		});

		expect(status).toEqual({
			branch: "main",
			head: "0123456789abcdef",
			remoteHead: "0123456789abcdef",
		});
	});
});
