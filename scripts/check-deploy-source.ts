import { spawnSync } from "node:child_process";

export interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export interface DeploySourceStatus {
	branch: string;
	head: string;
	remoteHead: string;
	worktreeStatus: string;
}

const DEPLOY_BRANCH = "main";
const DEPLOY_REMOTE_REF = "origin/main";
const DEPLOY_FETCH_REFSPEC = "refs/heads/main:refs/remotes/origin/main";

export function runCommand(command: string, args: string[]): CommandResult {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return {
		status: result.status ?? 1,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

export function getDeploySourceStatus(runner: CommandRunner = runCommand): DeploySourceStatus {
	requireCommand(runner, "git", ["fetch", "origin", DEPLOY_FETCH_REFSPEC]);

	return {
		branch: requireCommand(runner, "git", ["branch", "--show-current"]),
		head: requireCommand(runner, "git", ["rev-parse", "HEAD"]),
		remoteHead: requireCommand(runner, "git", ["rev-parse", DEPLOY_REMOTE_REF]),
		worktreeStatus: requireCommand(runner, "git", ["status", "--porcelain"]),
	};
}

export function validateDeploySource(status: DeploySourceStatus): string[] {
	const problems: string[] = [];

	if (status.branch !== DEPLOY_BRANCH) {
		problems.push(
			`deploy は ${DEPLOY_BRANCH} ブランチから実行してください: current=${status.branch}`,
		);
	}

	if (status.head !== status.remoteHead) {
		problems.push(
			`deploy 元が ${DEPLOY_REMOTE_REF} と一致していません: HEAD=${shortSha(status.head)} ${DEPLOY_REMOTE_REF}=${shortSha(status.remoteHead)}`,
		);
	}

	if (status.worktreeStatus !== "") {
		problems.push("deploy 元に未コミット変更があります。作業ツリーを clean にしてください。");
	}

	return problems;
}

function requireCommand(runner: CommandRunner, command: string, args: string[]): string {
	const result = runner(command, args);
	if (result.status !== 0) {
		const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
		throw new Error(`${[command, ...args].join(" ")} failed: ${output}`);
	}
	return result.stdout.trim();
}

function shortSha(sha: string): string {
	return sha.length > 7 ? sha.slice(0, 7) : sha;
}

if (import.meta.main) {
	try {
		const status = getDeploySourceStatus();
		const problems = validateDeploySource(status);
		if (problems.length > 0) {
			for (const problem of problems) console.error(`[deploy] ${problem}`);
			process.exit(1);
		}
		console.log(`[deploy] source verified: ${DEPLOY_BRANCH}@${shortSha(status.head)}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[deploy] source check failed: ${message}`);
		process.exit(1);
	}
}
