import { mkdirSync, writeFileSync } from "node:fs";

import { GITHUB_GIT_CREDENTIAL_HELPER } from "./github-auth-env.ts";

export interface ShellWorkspaceGitConfig {
	userName: string;
	userEmail: string;
}

export function workspaceGitConfigPath(workspaceDir: string): string {
	return `${workspaceGitConfigDir(workspaceDir)}/config`;
}

export function writeShellWorkspaceGitConfig(
	workspaceDir: string,
	config: ShellWorkspaceGitConfig,
): string {
	const path = workspaceGitConfigPath(workspaceDir);
	mkdirSync(workspaceGitConfigDir(workspaceDir), { recursive: true });
	writeFileSync(path, buildShellWorkspaceGitConfig(config));
	return path;
}

export function buildShellWorkspaceGitConfig(config: ShellWorkspaceGitConfig): string {
	return `${[
		"[user]",
		`\tname = ${quoteGitConfigValue(config.userName)}`,
		`\temail = ${quoteGitConfigValue(config.userEmail)}`,
		"[init]",
		"\tdefaultBranch = main",
		'[credential "https://github.com"]',
		`\thelper = ${quoteGitConfigValue(GITHUB_GIT_CREDENTIAL_HELPER)}`,
	].join("\n")}\n`;
}

function quoteGitConfigValue(value: string): string {
	if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
		throw new Error("git config value must not contain NUL or newline");
	}
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function workspaceGitConfigDir(workspaceDir: string): string {
	return `${trimTrailingSlashes(workspaceDir)}/.config/git`;
}

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 1 && value[end - 1] === "/") end--;
	return value.slice(0, end);
}
