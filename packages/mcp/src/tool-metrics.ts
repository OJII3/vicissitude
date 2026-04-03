import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@vicissitude/shared/types";

export interface MetricsOptions {
	counts: Map<string, number>;
	logger?: Logger;
}

/**
 * server.registerTool() 呼び出しをインターセプトし、各ツールのハンドラ実行時にカウンタをインクリメントする。
 * Proxy を使って McpServer を薄くラップすることで、個々のツール登録関数を変更せずに全ツールを計測できる。
 */
export function wrapServerWithMetrics(server: McpServer, options: MetricsOptions): McpServer {
	const { counts, logger } = options;

	function increment(key: string): void {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	function handleError(name: string, err: unknown): never {
		increment(`${name}:error`);
		if (logger) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error(`[tool-metrics] ${name}: ${message}`);
		}
		throw err;
	}

	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
			// oxlint-disable-next-line no-explicit-any -- McpServer.registerTool() のコールバック型を正確に表現できないため any で受ける
			return (name: string, config: any, cb: (...handlerArgs: any[]) => any) => {
				// oxlint-disable-next-line no-explicit-any -- handler の引数型はツールごとに異なる
				// oxlint-disable-next-line no-explicit-any -- wrappedCb は元の cb と同じ戻り値型を維持する必要がある
				const wrappedCb = (...handlerArgs: any[]): any => {
					// oxlint-disable-next-line no-explicit-any -- cb の戻り値は同期/非同期で異なるため any で受ける
					let result: any;
					try {
						result = cb(...handlerArgs);
					} catch (err) {
						handleError(name, err);
					}

					if (result !== null && result !== undefined && typeof result.then === "function") {
						return result.then(
							// oxlint-disable-next-line no-explicit-any -- Promise の resolve 値はツールごとに異なる
							(value: any) => {
								increment(`${name}:success`);
								return value;
							},
							(err: unknown) => {
								handleError(name, err);
							},
						);
					}

					increment(`${name}:success`);
					return result;
				};
				return target.registerTool(name, config, wrappedCb);
			};
		},
	});
}
