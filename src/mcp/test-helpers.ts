/** SSE またはプレーン JSON の MCP レスポンスを解析して JSON-RPC レスポンスを返す */
export async function parseMcpResponse(res: Response): Promise<Record<string, unknown>> {
	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		const text = await res.text();
		// SSE: "data: {...}\n\n" 形式の最後の JSON-RPC レスポンスを取得
		const lines = text.split("\n");
		let lastData: string | undefined;
		for (const line of lines) {
			if (line.startsWith("data: ")) {
				lastData = line.slice(6);
			}
		}
		if (!lastData) throw new Error("No SSE data found");
		return JSON.parse(lastData) as Record<string, unknown>;
	}
	return res.json() as Promise<Record<string, unknown>>;
}
