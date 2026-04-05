import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { SpotifyAuth } from "./auth.ts";

describe("auth – fetchToken internals", () => {
	let originalFetch: typeof globalThis.fetch;
	let capturedUrl: string | URL | Request;
	let capturedInit: RequestInit | undefined;

	const config = {
		clientId: "cid",
		clientSecret: "csec",
		refreshToken: "rt",
	};

	const defaultBody = { access_token: "tok", expires_in: 3600 };
	function installMockFetch(body: unknown = defaultBody, status = 200) {
		const fn = mock((url: string | URL | Request, init?: RequestInit) => {
			capturedUrl = url;
			capturedInit = init;
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		});
		globalThis.fetch = fn as unknown as typeof fetch;
		return fn;
	}

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("正しい URL に POST する", async () => {
		installMockFetch();
		const auth = new SpotifyAuth(config);
		await auth.getAccessToken();

		expect(capturedUrl).toBe("https://accounts.spotify.com/api/token");
		expect(capturedInit?.method).toBe("POST");
	});

	it("Content-Type が application/x-www-form-urlencoded である", async () => {
		installMockFetch();
		const auth = new SpotifyAuth(config);
		await auth.getAccessToken();

		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
	});

	it("credentials が Base64 エンコードされて Authorization ヘッダーに付与される", async () => {
		installMockFetch();
		const auth = new SpotifyAuth(config);
		await auth.getAccessToken();

		const expectedCredentials = btoa(`${config.clientId}:${config.clientSecret}`);
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Basic ${expectedCredentials}`);
	});

	it("body に grant_type=refresh_token と refresh_token が含まれる", async () => {
		installMockFetch();
		const auth = new SpotifyAuth(config);
		await auth.getAccessToken();

		const body = capturedInit?.body as URLSearchParams;
		expect(body).toBeInstanceOf(URLSearchParams);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe(config.refreshToken);
	});

	it("AbortSignal.timeout(10_000) が設定されている", async () => {
		installMockFetch();
		const auth = new SpotifyAuth(config);
		await auth.getAccessToken();

		expect(capturedInit?.signal).toBeDefined();
	});
});

describe("auth – キャッシュの有効期限計算", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalDateNow: typeof Date.now;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalDateNow = Date.now;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		Date.now = originalDateNow;
	});

	it("expiresAt が Date.now() + expires_in * 1000 で計算される", async () => {
		const fakeNow = 1_000_000;
		const expiresIn = 3600;
		Date.now = () => fakeNow;

		let callCount = 0;
		const fn = mock(() => {
			callCount++;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						access_token: `tok-${callCount}`,
						expires_in: expiresIn,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		});
		globalThis.fetch = fn as unknown as typeof fetch;

		const { SpotifyAuth: DynAuth } = await import("./auth.ts");
		const auth = new DynAuth({
			clientId: "cid",
			clientSecret: "csec",
			refreshToken: "rt",
		});

		await auth.getAccessToken();

		// expiresAt = 1_000_000 + 3600 * 1000 = 4_600_000
		// At fakeNow (1_000_000), cache is still valid → should NOT refetch
		const tok2 = await auth.getAccessToken();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(tok2).toBe("tok-1");

		// Move time past expiry
		Date.now = () => fakeNow + expiresIn * 1000 + 1;
		const tok3 = await auth.getAccessToken();
		expect(fn).toHaveBeenCalledTimes(2);
		expect(tok3).toBe("tok-2");
	});

	it("expires_in=0 ではキャッシュが即座に無効になる", async () => {
		const fakeNow = 1_000_000;
		Date.now = () => fakeNow;

		let callCount = 0;
		const fn = mock(() => {
			callCount++;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						access_token: `tok-${callCount}`,
						expires_in: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		});
		globalThis.fetch = fn as unknown as typeof fetch;

		const { SpotifyAuth: DynAuth } = await import("./auth.ts");
		const auth = new DynAuth({
			clientId: "cid",
			clientSecret: "csec",
			refreshToken: "rt",
		});

		await auth.getAccessToken();
		// expiresAt = fakeNow + 0 = fakeNow, and condition is Date.now() < expiresAt → false
		await auth.getAccessToken();
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
