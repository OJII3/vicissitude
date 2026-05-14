import { describe, expect, test } from "bun:test";

import { HttpFxEmbedClient, parseTwitterUrl } from "@vicissitude/infrastructure/discord/fxembed";

describe("parseTwitterUrl (integration)", () => {
	test("x.com URL を正しくパースする", () => {
		const result = parseTwitterUrl("https://x.com/ojii3dev/status/1900000000000000000");
		expect(result).toEqual({
			handle: "ojii3dev",
			statusId: "1900000000000000000",
		});
	});

	test("プロフィール URL を正しくパースする", () => {
		const result = parseTwitterUrl("https://x.com/ojii3dev");
		expect(result).toEqual({
			handle: "ojii3dev",
			statusId: undefined,
		});
	});
});

describe("HttpFxEmbedClient (integration)", () => {
	test("クライアントがインスタンス化できる", () => {
		const client = new HttpFxEmbedClient();
		expect(client).toBeInstanceOf(HttpFxEmbedClient);
	});

	test("getStatus は 404 で null を返す", async () => {
		const client = new HttpFxEmbedClient({
			fetchFn: () =>
				Promise.resolve(
					new Response(JSON.stringify({ code: 404, message: "Not found" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					}),
				),
		});
		const result = await client.getStatus("nonexistent");
		expect(result).toBeNull();
	});

	test("getProfile は 404 で null を返す", async () => {
		const client = new HttpFxEmbedClient({
			fetchFn: () =>
				Promise.resolve(
					new Response(JSON.stringify({ code: 404, message: "Not found" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					}),
				),
		});
		const result = await client.getProfile("nonexistent_user_xyz");
		expect(result).toBeNull();
	});
});
