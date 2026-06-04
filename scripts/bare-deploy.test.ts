import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runShell(command: string, env: Record<string, string>): string {
	const bashPath = Bun.which("bash");
	if (!bashPath) throw new Error("bash is required for bare deploy tests");

	const proc = Bun.spawnSync([bashPath, "-lc", command], {
		cwd: process.cwd(),
		env: {
			...process.env,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(proc.stderr.toString() || proc.stdout.toString());
	}
	return proc.stdout.toString().trim();
}

describe("deploy/common/nix.sh", () => {
	test("PATH に nix がなくても ~/.nix-profile/bin/nix を解決する", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "vicissitude-nix-home-"));
		const fakeNix = join(homeDir, ".nix-profile", "bin", "nix");
		mkdirSync(join(homeDir, ".nix-profile", "bin"), { recursive: true });
		writeFileSync(fakeNix, "#!/usr/bin/env bash\nprintf '%s\\n' \"$0\"\n");
		chmodSync(fakeNix, 0o755);

		const output = runShell(
			"source deploy/common/nix.sh && PATH=/usr/bin:/bin && vicissitude_require_nix",
			{
				HOME: homeDir,
				PATH: "/usr/bin:/bin",
			},
		);

		expect(output).toBe(fakeNix);
	});
});
