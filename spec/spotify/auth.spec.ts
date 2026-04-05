import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { SpotifyAuth } from "@vicissitude/spotify/auth";

// --- stub factory ---

function createMockFetch(responses: Array<{ status: number; body: unknown }>) {
	let callIndex = 0;
	return mock((_url: string | URL | Request, _init?: RequestInit) => {
		const res = responses[callIndex++];
		if (!res) throw new Error("unexpected fetch call");
		return Promise.resolve(
			new Response(JSON.stringify(res.body), {
				status: res.status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
}

let tokenCounter = 0;
function tokenResponse(expiresIn = 3600) {
	return {
		status: 200,
		body: {
			access_token: `token-${++tokenCounter}`,
			token_type: "Bearer",
			expires_in: expiresIn,
		},
	};
}

describe("SpotifyAuth", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("getAccessToken() でアクセストークンを取得できる", async () => {
		const mockFetch = createMockFetch([tokenResponse()]);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const { createSpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = createSpotifyAuth({
			clientId: "test-client-id",
			clientSecret: "test-client-secret",
			refreshToken: "test-refresh-token",
		});

		const token = await auth.getAccessToken();

		expect(token).toBeString();
		expect(token.length).toBeGreaterThan(0);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("トークンがキャッシュされ、有効期限内は再取得しない", async () => {
		const mockFetch = createMockFetch([tokenResponse(3600)]);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const { createSpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = createSpotifyAuth({
			clientId: "test-client-id",
			clientSecret: "test-client-secret",
			refreshToken: "test-refresh-token",
		});

		const token1 = await auth.getAccessToken();
		const token2 = await auth.getAccessToken();

		expect(token1).toBe(token2);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("有効期限切れ時にリフレッシュトークンで自動更新する", async () => {
		// first response expires immediately, second is a fresh token
		const mockFetch = createMockFetch([tokenResponse(0), tokenResponse(3600)]);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const { createSpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = createSpotifyAuth({
			clientId: "test-client-id",
			clientSecret: "test-client-secret",
			refreshToken: "test-refresh-token",
		});

		const token1 = await auth.getAccessToken();
		// Force expiry by waiting or by design (expiresIn=0)
		const token2 = await auth.getAccessToken();

		expect(token2).not.toBe(token1);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("API エラー時に適切なエラーをスローする", async () => {
		const mockFetch = createMockFetch([{ status: 401, body: { error: "invalid_client" } }]);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const { createSpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = createSpotifyAuth({
			clientId: "bad-client-id",
			clientSecret: "bad-client-secret",
			refreshToken: "bad-refresh-token",
		});

		expect(() => auth.getAccessToken()).toThrow();
	});
});
