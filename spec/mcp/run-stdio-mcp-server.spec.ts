import { describe, expect, test } from "bun:test";

/**
 * `runStdioMcpServer` のブラックボックス契約テスト。
 *
 * `process.exit` / `process.on(SIGINT|SIGTERM)` / stdio transport を絡むため、
 * 子プロセスを起動して観測する。テスト用ハーネスは `runStdioMcpServer` を呼び、
 * setup コールバック内で診断ログを出すだけのダミー server を構成する。
 *
 * setup の中で `server.connect` の前に発生する挙動（logger / exit / namespace warn）を
 * stderr とプロセス終了コードで固定する。transport 接続後はプロセスが stdin 待ちで
 * ブロックするため、その状態（exit していないこと）も検証する。
 */

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** タイムアウトで kill された（= main がブロック状態に入った）場合 true。 */
	killed: boolean;
}

/**
 * 子プロセスでテスト用ハーネスを実行する。
 *
 * `sendSignal` を指定すると、起動後一定時間待ってから当該シグナルを送り、
 * graceful shutdown 経路を観測する。
 */
async function runHarness(opts: {
	env: Record<string, string | undefined>;
	sendSignal?: "SIGINT" | "SIGTERM";
}): Promise<RunResult> {
	const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
	for (const [k, v] of Object.entries(opts.env)) {
		if (v === undefined) delete env[k];
	}

	const harness = `
import { runStdioMcpServer } from "@vicissitude/mcp/run-stdio-mcp-server";

await runStdioMcpServer({
  name: "harness",
  version: "9.9.9",
  missingScopeHint: "scope_id",
  setup: (ctx) => {
    console.error("SETUP agentId=" + ctx.agentId);
    console.error("SETUP boundScopeId=" + String(ctx.boundScopeId));
    console.error("SETUP boundNamespace=" + (ctx.boundNamespace ? ctx.boundNamespace.surface : "undefined"));
    console.error("SETUP serverName=" + (ctx.server ? "present" : "missing"));
    return () => {
      console.error("CLEANUP called");
    };
  },
});
`;

	const proc = Bun.spawn(["bun", "-e", harness], {
		cwd: process.cwd(),
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	let killed = false;
	if (opts.sendSignal) {
		// transport.connect 後に shutdown 経路へ入れるよう少し待ってからシグナルを送る。
		await Bun.sleep(400);
		proc.kill(opts.sendSignal === "SIGINT" ? "SIGINT" : "SIGTERM");
	}

	const exitCode = await Promise.race([
		proc.exited,
		Bun.sleep(2_000).then(() => {
			killed = true;
			proc.kill();
			return -1;
		}),
	]);

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr, killed };
}

// 有効な AGENT_ID（discord guild → agent-scope namespace に解決される）
const RESOLVABLE_AGENT_ID = "discord:123456789012345678";
// namespace に解決できない AGENT_ID
const UNRESOLVABLE_AGENT_ID = "totally-not-a-valid-agent-id";

describe("runStdioMcpServer", () => {
	describe("AGENT_ID 検証", () => {
		test("AGENT_ID が欠落していると error を出力して exit code 1 で終了する", async () => {
			const result = await runHarness({ env: { AGENT_ID: undefined } });

			expect(result.exitCode).toBe(1);
		});

		test("AGENT_ID 欠落時の error 文言は [<name>-server] プレフィックス付きで required を伝える", async () => {
			const result = await runHarness({ env: { AGENT_ID: undefined } });

			expect(result.stderr).toContain("[harness-server] AGENT_ID environment variable is required");
		});

		test("AGENT_ID 欠落時は setup コールバックを呼ばない", async () => {
			const result = await runHarness({ env: { AGENT_ID: undefined } });

			expect(result.stderr).not.toContain("SETUP");
		});
	});

	describe("namespace 解決", () => {
		test("解決可能な AGENT_ID では setup に agent-scope の boundNamespace を渡す", async () => {
			const result = await runHarness({ env: { AGENT_ID: RESOLVABLE_AGENT_ID } });

			expect(result.stderr).toContain("SETUP boundNamespace=agent-scope");
		});

		test("解決可能な AGENT_ID では setup に boundScopeId を導出して渡す", async () => {
			const result = await runHarness({ env: { AGENT_ID: RESOLVABLE_AGENT_ID } });

			expect(result.stderr).toContain("SETUP boundScopeId=discord:guild:123456789012345678");
		});

		test("解決可能な AGENT_ID では namespace 未解決 warn を出さない", async () => {
			const result = await runHarness({ env: { AGENT_ID: RESOLVABLE_AGENT_ID } });

			expect(result.stderr).not.toContain("did not resolve to a known namespace");
		});

		test("解決できない AGENT_ID では missingScopeHint を含む warn を出す", async () => {
			const result = await runHarness({ env: { AGENT_ID: UNRESOLVABLE_AGENT_ID } });

			expect(result.stderr).toContain(
				`[harness-server] AGENT_ID=${UNRESOLVABLE_AGENT_ID} did not resolve to a known namespace — tools require explicit scope_id`,
			);
		});

		test("解決できない AGENT_ID では boundScopeId を undefined として setup に渡す", async () => {
			const result = await runHarness({ env: { AGENT_ID: UNRESOLVABLE_AGENT_ID } });

			expect(result.stderr).toContain("SETUP boundScopeId=undefined");
		});
	});

	describe("setup コンテキスト", () => {
		test("setup に検証済み agentId を渡す", async () => {
			const result = await runHarness({ env: { AGENT_ID: RESOLVABLE_AGENT_ID } });

			expect(result.stderr).toContain(`SETUP agentId=${RESOLVABLE_AGENT_ID}`);
		});

		test("setup に McpServer インスタンスを渡す", async () => {
			const result = await runHarness({ env: { AGENT_ID: RESOLVABLE_AGENT_ID } });

			expect(result.stderr).toContain("SETUP serverName=present");
		});
	});

	describe("起動", () => {
		test("正常系では transport 接続後にプロセスがブロックし、setup 後すぐには終了しない", async () => {
			const result = await runHarness({ env: { AGENT_ID: RESOLVABLE_AGENT_ID } });

			// stdin 待ちでブロックするため、タイムアウト kill されるのが期待挙動。
			expect(result.killed).toBe(true);
			expect(result.stderr).toContain("SETUP serverName=present");
		});
	});

	describe("graceful shutdown", () => {
		test("SIGINT で setup が返した cleanup を呼んでから exit code 0 で終了する", async () => {
			const result = await runHarness({
				env: { AGENT_ID: RESOLVABLE_AGENT_ID },
				sendSignal: "SIGINT",
			});

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("CLEANUP called");
		});

		test("SIGTERM でも cleanup を呼んでから exit code 0 で終了する", async () => {
			const result = await runHarness({
				env: { AGENT_ID: RESOLVABLE_AGENT_ID },
				sendSignal: "SIGTERM",
			});

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("CLEANUP called");
		});
	});
});
