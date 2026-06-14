import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { METRIC } from "@vicissitude/observability/metrics";
import type { Logger, MetricsCollector } from "@vicissitude/shared/types";

/** registerTool の config 第2引数（説明文のみ参照する）。 */
interface ToolConfigLike {
	description?: string;
}

/** registerTool のハンドラ。引数・戻り値はツールごとに異なるため広めに受ける。 */
type ToolHandler = (...args: unknown[]) => unknown;

/** McpServer のうち、本ラッパが介入する registerTool だけを抽出した構造的な型。 */
interface RegisterToolLike {
	registerTool(name: string, config: ToolConfigLike, cb: ToolHandler): unknown;
}

export interface MetricsOptions {
	metrics: MetricsCollector;
	logger?: Logger;
	toolDescriptions?: Map<string, string | undefined>;
	/**
	 * 計測に使うカウンタ名。省略時は `mcp_tool_calls_total`。
	 * Minecraft MCP など別系統のカウンタへ記録したい場合に指定する。
	 */
	metricName?: string;
}

function isThenable(value: unknown): value is Promise<unknown> {
	return (
		value !== null &&
		value !== undefined &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/**
 * server.registerTool() 呼び出しをインターセプトし、各ツールのハンドラ実行を計測する。
 * Proxy を使って McpServer を薄くラップすることで、個々のツール登録関数を変更せずに全ツールを計測できる。
 *
 * 記録仕様:
 * - ハンドラ完了後に `metricName` カウンタを `{ tool, outcome: "success"|"error" }` ラベルで 1 加算する。
 * - 同期/非同期（Promise）いずれのハンドラも outcome を判定する。
 * - エラー時は outcome="error" を記録し、logger があれば error ログを出してから rethrow する。
 * - `toolDescriptions` が渡された場合は登録時に `set(name, config.description)` で説明を記録する。
 */
export function wrapServerWithMetrics(server: McpServer, options: MetricsOptions): McpServer {
	const { metrics, logger, toolDescriptions, metricName = METRIC.MCP_TOOL_CALLS } = options;

	function increment(toolName: string, outcome: "success" | "error"): void {
		metrics.incrementCounter(metricName, { tool: toolName, outcome });
	}

	function handleError(name: string, err: unknown): never {
		increment(name, "error");
		if (logger) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`[tool-metrics] ${name}: ${message}`);
		}
		throw err;
	}

	return new Proxy(server, {
		get(target, prop, receiver) {
			// oxlint-disable-next-line typescript/no-unsafe-return -- Proxy の get トラップは any を返す
			if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
			const delegate = target as unknown as RegisterToolLike;
			return (name: string, config: ToolConfigLike, cb: ToolHandler): unknown => {
				toolDescriptions?.set(name, config?.description);
				const wrappedCb: ToolHandler = (...handlerArgs: unknown[]): unknown => {
					let result: unknown;
					try {
						result = cb(...handlerArgs);
					} catch (err) {
						handleError(name, err);
					}

					if (isThenable(result)) {
						return result.then(
							(value) => {
								increment(name, "success");
								return value;
							},
							(err: unknown) => handleError(name, err),
						);
					}

					increment(name, "success");
					return result;
				};
				return delegate.registerTool(name, config, wrappedCb);
			};
		},
	});
}
