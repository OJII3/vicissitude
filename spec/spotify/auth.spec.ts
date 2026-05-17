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

function fixedTokenResponse(accessToken: string, expiresIn = 3600) {
	return {
		access_token: accessToken,
		token_type: "Bearer",
		expires_in: expiresIn,
	};
}

function createTestSignal(): AbortSignal {
	return new AbortController().signal;
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

		const { SpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = new SpotifyAuth({
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

		const { SpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = new SpotifyAuth({
			clientId: "test-client-id",
			clientSecret: "test-client-secret",
			refreshToken: "test-refresh-token",
		});

		const token1 = await auth.getAccessToken();
		const token2 = await auth.getAccessToken();

		expect(token1).toBe(token2);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("トークン未取得時の並行 getAccessToken() は in-flight refresh を共有する", async () => {
		let resolveFetch: ((response: Response) => void) | undefined;
		const fetchPromise = new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		});
		const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) => fetchPromise);

		const { SpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = new SpotifyAuth(
			{
				clientId: "test-client-id",
				clientSecret: "test-client-secret",
				refreshToken: "test-refresh-token",
			},
			undefined,
			{
				fetch: mockFetch,
				timeoutSignal: createTestSignal,
				now: () => 1_000,
			},
		);

		const token1 = auth.getAccessToken();
		const token2 = auth.getAccessToken();
		await Promise.resolve();

		expect(mockFetch).toHaveBeenCalledTimes(1);
		resolveFetch?.(
			new Response(JSON.stringify(fixedTokenResponse("shared-token", 3600)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(await Promise.all([token1, token2])).toEqual(["shared-token", "shared-token"]);
	});

	it("期限切れ時の並行 getAccessToken() も 1 回の refresh を共有する", async () => {
		let now = 1_000;
		let resolveSecondFetch: ((response: Response) => void) | undefined;
		const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) => {
			if (mockFetch.mock.calls.length === 1) {
				return Promise.resolve(
					new Response(JSON.stringify(fixedTokenResponse("expired-token", 0)), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}

			return new Promise<Response>((resolve) => {
				resolveSecondFetch = resolve;
			});
		});

		const { SpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = new SpotifyAuth(
			{
				clientId: "test-client-id",
				clientSecret: "test-client-secret",
				refreshToken: "test-refresh-token",
			},
			undefined,
			{
				fetch: mockFetch,
				timeoutSignal: createTestSignal,
				now: () => now,
			},
		);

		expect(await auth.getAccessToken()).toBe("expired-token");
		now = 2_000;

		const token1 = auth.getAccessToken();
		const token2 = auth.getAccessToken();
		await Promise.resolve();

		expect(mockFetch).toHaveBeenCalledTimes(2);
		resolveSecondFetch?.(
			new Response(JSON.stringify(fixedTokenResponse("refreshed-token", 3600)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(await Promise.all([token1, token2])).toEqual(["refreshed-token", "refreshed-token"]);
	});

	it("fetch / timeoutSignal / now は注入された依存を使用する", async () => {
		let now = 10_000;
		const signal = createTestSignal();
		let capturedSignal: AbortSignal | null | undefined;
		const mockFetch = mock((_url: string | URL | Request, init?: RequestInit) => {
			capturedSignal = init?.signal;
			return Promise.resolve(
				new Response(JSON.stringify(fixedTokenResponse("injected-token", 10)), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
		const timeoutSignal = mock((ms: number) => {
			expect(ms).toBe(10_000);
			return signal;
		});

		const { SpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = new SpotifyAuth(
			{
				clientId: "test-client-id",
				clientSecret: "test-client-secret",
				refreshToken: "test-refresh-token",
			},
			undefined,
			{
				fetch: mockFetch,
				timeoutSignal,
				now: () => now,
			},
		);

		expect(await auth.getAccessToken()).toBe("injected-token");
		now = 19_999;
		expect(await auth.getAccessToken()).toBe("injected-token");

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(timeoutSignal).toHaveBeenCalledTimes(1);
		expect(capturedSignal).toBe(signal);
	});

	it("有効期限切れ時にリフレッシュトークンで自動更新する", async () => {
		// first response expires immediately, second is a fresh token
		const mockFetch = createMockFetch([tokenResponse(0), tokenResponse(3600)]);
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		const { SpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = new SpotifyAuth({
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

		const { SpotifyAuth } = await import("@vicissitude/spotify/auth");
		const auth: SpotifyAuth = new SpotifyAuth({
			clientId: "bad-client-id",
			clientSecret: "bad-client-secret",
			refreshToken: "bad-refresh-token",
		});

		expect(auth.getAccessToken()).rejects.toThrow();
	});
});
