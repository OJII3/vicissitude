export interface SpotifyAuth {
	getAccessToken(): Promise<string>;
}

interface TokenCache {
	accessToken: string;
	expiresAt: number;
}

export function createSpotifyAuth(config: {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): SpotifyAuth {
	let cache: TokenCache | null = null;

	async function fetchToken(): Promise<TokenCache> {
		const credentials = btoa(`${config.clientId}:${config.clientSecret}`);
		const response = await fetch("https://accounts.spotify.com/api/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${credentials}`,
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: config.refreshToken,
			}),
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			throw new Error(`Spotify token request failed: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as {
			access_token: string;
			expires_in: number;
		};

		return {
			accessToken: data.access_token,
			expiresAt: Date.now() + data.expires_in * 1000,
		};
	}

	return {
		async getAccessToken(): Promise<string> {
			if (cache && Date.now() < cache.expiresAt) {
				return cache.accessToken;
			}
			cache = await fetchToken();
			return cache.accessToken;
		},
	};
}
