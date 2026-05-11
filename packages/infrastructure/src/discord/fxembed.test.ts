import { describe, expect, test } from "bun:test";

import {
	HttpFxEmbedClient,
	parseTwitterUrl,
} from "./fxembed.ts";

function createMockFetch(responses: Record<string, unknown>): (url: string) => Promise<Response> {
	return async (url: string) => {
		const key = Object.keys(responses).find((k) => url.endsWith(k));
		if (key) {
			return new Response(JSON.stringify(responses[key]), {
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	};
}

describe("parseTwitterUrl", () => {
	test("x.com のステータス URL をパースする", () => {
		const result = parseTwitterUrl("https://x.com/ojii3dev/status/1234567890");
		expect(result).toEqual({ handle: "ojii3dev", statusId: "1234567890" });
	});

	test("twitter.com のステータス URL をパースする", () => {
		const result = parseTwitterUrl("https://twitter.com/user/status/999");
		expect(result).toEqual({ handle: "user", statusId: "999" });
	});

	test("www 付き URL をパースする", () => {
		const result = parseTwitterUrl("https://www.x.com/handle/status/111");
		expect(result).toEqual({ handle: "handle", statusId: "111" });
	});

	test("プロフィールのみの URL をパースする (statusId なし)", () => {
		const result = parseTwitterUrl("https://x.com/ojii3dev");
		expect(result).toEqual({ handle: "ojii3dev", statusId: undefined });
	});

	test("mobile.x.com をパースする", () => {
		const result = parseTwitterUrl("https://mobile.x.com/user/status/1");
		expect(result).toEqual({ handle: "user", statusId: "1" });
	});

	test("http スキームでもパースする", () => {
		const result = parseTwitterUrl("http://x.com/user/status/1");
		expect(result).toEqual({ handle: "user", statusId: "1" });
	});

	test("無関係な URL は null を返す", () => {
		expect(parseTwitterUrl("https://github.com/test")).toBeNull();
	});

	test("fxtwitter.com はパースしない (API 用ではない)", () => {
		expect(parseTwitterUrl("https://fxtwitter.com/user/status/1")).toBeNull();
	});
});

describe("HttpFxEmbedClient", () => {
	test("getStatus でツイートを取得する", async () => {
		const status = {
			type: "status",
			id: "123",
			url: "https://x.com/test/status/123",
			text: "Hello",
			created_at: "2024-01-01T00:00:00Z",
			created_timestamp: 1704067200,
			likes: 10,
			reposts: 5,
			quotes: 2,
			replies: 3,
			author: {
				type: "profile",
				id: "456",
				name: "Test User",
				screen_name: "test",
				avatar_url: "https://pbs.twimg.com/test.jpg",
				banner_url: null,
				description: "hello",
				followers: 100,
				following: 50,
				statuses: 200,
				likes: 300,
				protected: false,
			},
		};
		const client = new HttpFxEmbedClient({
			fetchFn: createMockFetch({ "/2/status/123": { code: 200, status } }),
		});
		const result = await client.getStatus("123");
		expect(result).not.toBeNull();
		expect(result!.id).toBe("123");
		expect(result!.text).toBe("Hello");
		expect(result!.author.screen_name).toBe("test");
	});

	test("getStatus は HTTP エラーで null を返す", async () => {
		const client = new HttpFxEmbedClient({
			fetchFn: () => Promise.resolve(new Response("not found", { status: 404 })),
		});
		const result = await client.getStatus("999");
		expect(result).toBeNull();
	});

	test("getStatus は不正な JSON で null を返す", async () => {
		const client = new HttpFxEmbedClient({
			fetchFn: () =>
				Promise.resolve(
					new Response(JSON.stringify({ code: 200, status: { invalid: true } }), {
						headers: { "content-type": "application/json" },
					}),
				),
		});
		const result = await client.getStatus("123");
		expect(result).toBeNull();
	});

	test("getProfile でプロフィールを取得する", async () => {
		const user = {
			type: "profile",
			id: "789",
			name: "Test User",
			screen_name: "testuser",
			avatar_url: "https://pbs.twimg.com/avatar.jpg",
			banner_url: "https://pbs.twimg.com/banner.jpg",
			description: "bio text",
			followers: 1000,
			following: 200,
			statuses: 500,
			likes: 800,
			protected: false,
		};
		const client = new HttpFxEmbedClient({
			fetchFn: createMockFetch({ "/2/profile/testuser": { code: 200, user } }),
		});
		const result = await client.getProfile("testuser");
		expect(result).not.toBeNull();
		expect(result!.screen_name).toBe("testuser");
		expect(result!.avatar_url).toBe("https://pbs.twimg.com/avatar.jpg");
	});

	test("getProfile は HTTP エラーで null を返す", async () => {
		const client = new HttpFxEmbedClient({
			fetchFn: () => Promise.resolve(new Response("not found", { status: 404 })),
		});
		const result = await client.getProfile("nonexistent");
		expect(result).toBeNull();
	});

	test("getProfile はネットワークエラーで null を返す", async () => {
		const client = new HttpFxEmbedClient({
			fetchFn: () => Promise.reject(new Error("network error")),
		});
		const result = await client.getProfile("test");
		expect(result).toBeNull();
	});
});
