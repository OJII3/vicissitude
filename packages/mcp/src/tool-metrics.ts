import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * server.registerTool() 呼び出しをインターセプトし、各ツールのハンドラ実行時にカウンタをインクリメントする。
 * Proxy を使って McpServer を薄くラップすることで、個々のツール登録関数を変更せずに全ツールを計測できる。
 */
export function wrapServerWithMetrics(server: McpServer, counts: Map<string, number>): McpServer {
	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
			// oxlint-disable-next-line no-explicit-any -- McpServer.registerTool() のコールバック型を正確に表現できないため any で受ける
			return (name: string, config: any, cb: (...handlerArgs: any[]) => any) => {
				// oxlint-disable-next-line no-explicit-any -- handler の引数型はツールごとに異なる
				const wrappedCb = (...handlerArgs: any[]) => {
					counts.set(name, (counts.get(name) ?? 0) + 1);
					return cb(...handlerArgs);
				};
				return target.registerTool(name, config, wrappedCb);
			};
		},
	});
}
