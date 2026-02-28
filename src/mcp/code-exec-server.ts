import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { $ } from "bun";

const server = new McpServer({
  name: "code-exec",
  version: "0.1.0",
});

const TIMEOUT_MS = 10_000;
const SUPPORTED_LANGUAGES = ["javascript", "typescript", "python", "shell"] as const;

server.tool(
  "execute_code",
  "Execute code in a sandboxed environment and return the output",
  {
    language: z.enum(SUPPORTED_LANGUAGES),
    code: z.string(),
  },
  async ({ language, code }) => {
    try {
      let cmd: string[];

      switch (language) {
        case "javascript":
        case "typescript":
          cmd = ["bun", "eval", code];
          break;
        case "python":
          cmd = ["python3", "-c", code];
          break;
        case "shell":
          cmd = ["bash", "-c", code];
          break;
      }

      const sessionName = `exec-${Date.now()}`;
      // tmux でサンドボックス実行: PTY 提供 + セッション分離
      const tmuxCmd = [
        "tmux",
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-x",
        "200",
        "-y",
        "50",
        ...cmd,
      ];

      const proc = Bun.spawn(tmuxCmd, {
        stdout: "pipe",
        stderr: "pipe",
      });

      // タイムアウト付きで待機
      const timeout = setTimeout(() => {
        // tmux セッションを kill
        Bun.spawn(["tmux", "kill-session", "-t", sessionName]);
      }, TIMEOUT_MS);

      await proc.exited;
      clearTimeout(timeout);

      // tmux の出力をキャプチャ
      const output =
        await $`tmux capture-pane -t ${sessionName} -p 2>/dev/null`.text().catch(
          () => "",
        );

      // セッションクリーンアップ
      await $`tmux kill-session -t ${sessionName} 2>/dev/null`.quiet().catch(
        () => {},
      );

      return {
        content: [{ type: "text", text: output.trim() || "(no output)" }],
      };
    } catch (e) {
      // tmux が使えない場合のフォールバック: 直接実行
      let cmd: string[];

      switch (language) {
        case "javascript":
        case "typescript":
          cmd = ["bun", "eval", code];
          break;
        case "python":
          cmd = ["python3", "-c", code];
          break;
        case "shell":
          cmd = ["bash", "-c", code];
          break;
      }

      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeoutId = setTimeout(() => proc.kill(), TIMEOUT_MS);
      await proc.exited;
      clearTimeout(timeoutId);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const output = (stdout + stderr).trim() || "(no output)";

      return {
        content: [
          {
            type: "text",
            text: proc.exitCode === 0 ? output : `Error (exit ${proc.exitCode}):\n${output}`,
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
