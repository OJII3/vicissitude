import { describe, expect, test } from "bun:test";

async function importEntrypoint(): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const env = { ...process.env };
	delete env.AGENT_ID;
	delete env.DISCORD_TOKEN;
	const proc = Bun.spawn(
		["bun", "-e", 'await import("@vicissitude/mcp/discord-server"); console.log("imported");'],
		{
			cwd: process.cwd(),
			env,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
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

describe("discord-server entrypoint", () => {
	test("module は import だけでは stdio server を起動しない", async () => {
		const result = await importEntrypoint();

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("imported");
		expect(result.stderr).not.toContain("DISCORD_TOKEN");
	});
});
