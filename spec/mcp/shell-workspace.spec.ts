import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";

import {
	buildShellPodmanCmd,
	normalizeWorkspaceRelativePath,
	ShellWorkspaceManager,
	type ProcessRunner,
} from "@vicissitude/mcp/shell-workspace";

function createConfig(
	overrides: Partial<ConstructorParameters<typeof ShellWorkspaceManager>[0]> = {},
) {
	const root = mkdtempSync(join(os.tmpdir(), "shell-workspace-test-"));
	return {
		agentId: "discord:123",
		image: "sandbox-image",
		dataDir: join(root, "workspaces"),
		auditLogPath: join(root, "audit.jsonl"),
		networkProfile: "open" as const,
		defaultTtlMinutes: 60,
		maxTtlMinutes: 120,
		defaultTimeoutSeconds: 30,
		maxTimeoutSeconds: 120,
		maxOutputChars: 50_000,
		...overrides,
	};
}

describe("normalizeWorkspaceRelativePath", () => {
	it("相対パスを正規化する", () => {
		expect(normalizeWorkspaceRelativePath("./foo/bar", "cwd")).toBe("foo/bar");
		expect(normalizeWorkspaceRelativePath("", "cwd")).toBe(".");
		expect(normalizeWorkspaceRelativePath(undefined, "cwd")).toBe(".");
	});

	it("workspace 外に出るパスを拒否する", () => {
		expect(() => normalizeWorkspaceRelativePath("/etc", "cwd")).toThrow("relative path");
		expect(() => normalizeWorkspaceRelativePath("../secret", "cwd")).toThrow(
			"must not contain '..'",
		);
		expect(() => normalizeWorkspaceRelativePath("C:\\Users", "cwd")).toThrow("relative path");
	});
});

describe("buildShellPodmanCmd", () => {
	it("open network と sandbox 制約を含む Podman command を組み立てる", () => {
		const cmd = buildShellPodmanCmd({
			image: "sandbox-image",
			workspaceDir: "/tmp/workspace",
			cwd: "project",
			command: "pwd",
			timeoutSeconds: 10,
		});

		expect(cmd).toContain("--network=pasta");
		expect(cmd).toContain("--read-only");
		expect(cmd).toContain("HOME=/workspace/.home");
		expect(cmd).toContain("XDG_CACHE_HOME=/workspace/.cache");
		expect(cmd).toContain("XDG_CONFIG_HOME=/workspace/.config");
		expect(cmd).toContain("TMPDIR=/workspace/.tmp");
		expect(cmd).toContain("--cap-drop=ALL");
		expect(cmd).toContain("--security-opt=no-new-privileges");
		expect(cmd).toContain("/tmp/workspace:/workspace:rw");
		expect(cmd).toContain("/workspace/project");
		expect(cmd.slice(-3)).toEqual(["bash", "-lc", "pwd"]);
	});

	it("network profile none ではネットワークを無効化する", () => {
		const cmd = buildShellPodmanCmd({
			image: "sandbox-image",
			workspaceDir: "/tmp/workspace",
			cwd: ".",
			command: "true",
			timeoutSeconds: 10,
			networkProfile: "none",
		});

		expect(cmd).toContain("--network=none");
	});
});

describe("ShellWorkspaceManager", () => {
	it("session を作成し、exec 結果と監査ログを記録する", async () => {
		let now = Date.parse("2026-05-07T00:00:00.000Z");
		const seenCommands: string[][] = [];
		const runner: ProcessRunner = (cmd) => {
			seenCommands.push([...cmd]);
			now += 123;
			return Promise.resolve({
				exitCode: 0,
				output: "ok",
				timedOut: false,
				outputTruncated: false,
			});
		};
		const config = createConfig({ now: () => now, runProcess: runner });
		const manager = new ShellWorkspaceManager(config);
		const session = manager.startSession({ label: "test", ttlMinutes: 10 });

		expect(statSync(session.workspaceDir).mode & 0o777).toBe(0o777);
		expect(existsSync(join(session.workspaceDir, ".home"))).toBe(true);
		expect(existsSync(join(session.workspaceDir, ".cache"))).toBe(true);
		expect(existsSync(join(session.workspaceDir, ".config"))).toBe(true);
		expect(existsSync(join(session.workspaceDir, ".tmp"))).toBe(true);

		const result = await manager.exec({
			sessionId: session.sessionId,
			command: "echo ok",
			cwd: ".",
		});

		expect(result.exitCode).toBe(0);
		expect(result.durationMs).toBe(123);
		expect(result.output).toBe("ok");
		expect(seenCommands).toHaveLength(1);
		const audit = JSON.parse(readFileSync(config.auditLogPath, "utf8").trim());
		expect(audit.agent_id).toBe("discord:123");
		expect(audit.session_id).toBe(session.sessionId);
		expect(audit.command).toBe("echo ok");
		expect(audit.exit_code).toBe(0);
		manager.close();
	});

	it("hostDataDir 指定時は Podman mount source だけホスト側 path を使う", async () => {
		const seenCommands: string[][] = [];
		const runner: ProcessRunner = (cmd) => {
			seenCommands.push([...cmd]);
			return Promise.resolve({
				exitCode: 0,
				output: "ok",
				timedOut: false,
				outputTruncated: false,
			});
		};
		const root = mkdtempSync(join(os.tmpdir(), "shell-workspace-paths-"));
		const dataDir = join(root, "container", "shell-workspaces");
		const hostDataDir = "/host/project/data/shell-workspaces";
		const config = createConfig({
			dataDir,
			hostDataDir,
			runProcess: runner,
		});
		const manager = new ShellWorkspaceManager(config);
		const session = manager.startSession({});

		await manager.exec({ sessionId: session.sessionId, command: "pwd" });

		expect(session.workspaceDir).toBe(join(dataDir, session.sessionId));
		expect(seenCommands[0]).toContain(`${hostDataDir}/${session.sessionId}:/workspace:rw`);
		manager.close();
	});

	it("期限切れ session を削除する", () => {
		let now = Date.parse("2026-05-07T00:00:00.000Z");
		const config = createConfig({ now: () => now });
		const manager = new ShellWorkspaceManager(config);
		const session = manager.startSession({ ttlMinutes: 1 });

		expect(existsSync(session.workspaceDir)).toBe(true);
		now += 61_000;
		manager.cleanupExpired();

		expect(manager.status()).toEqual([]);
		expect(existsSync(session.workspaceDir)).toBe(false);
	});

	it("exportFile は symlink による workspace 外参照を拒否する", () => {
		const config = createConfig();
		const manager = new ShellWorkspaceManager(config);
		const session = manager.startSession({});
		const outside = join(mkdtempSync(join(os.tmpdir(), "shell-outside-")), "secret.txt");
		writeFileSync(outside, "secret");
		symlinkSync(outside, join(session.workspaceDir, "leak.txt"));

		expect(() => manager.exportFile(session.sessionId, "leak.txt")).toThrow("inside the workspace");
		manager.close();
	});
});
