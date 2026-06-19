import { describe, expect, test } from "bun:test";

async function importEntrypoint(specifier: string): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const env = { ...process.env };
	delete env.MC_HOST;
	const proc = Bun.spawn(["bun", "-e", `await import("${specifier}"); console.log("imported");`], {
		cwd: process.cwd(),
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await Promise.race([
		proc.exited,
		Bun.sleep(1_000).then(() => {
			proc.kill();
			return -1;
		}),
	]);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

describe("Minecraft entrypoints", () => {
	test("server module は import だけではプロセスを起動しない", async () => {
		const result = await importEntrypoint("@vicissitude/minecraft/server");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("imported");
		expect(result.stderr).not.toContain("MC_HOST is required");
	});

	test("mc-bridge-server module は import だけでは stdio server を起動しない", async () => {
		const result = await importEntrypoint("@vicissitude/minecraft/mc-bridge-server");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("imported");
	});
});
