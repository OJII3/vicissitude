export interface SpotifyAuthPort {
	getAccessToken(): Promise<string>;
}

interface TokenCache {
	accessToken: string;
	expiresAt: number;
}

export class SpotifyAuth implements SpotifyAuthPort {
	private cache: TokenCache | null = null;

	constructor(
		private readonly config: {
			clientId: string;
			clientSecret: string;
			refreshToken: string;
		},
	) {}

	private async fetchToken(): Promise<TokenCache> {
		const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
		const response = await fetch("https://accounts.spotify.com/api/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${credentials}`,
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: this.config.refreshToken,
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

	async getAccessToken(): Promise<string> {
		if (this.cache && Date.now() < this.cache.expiresAt) {
			return this.cache.accessToken;
		}
		this.cache = await this.fetchToken();
		return this.cache.accessToken;
	}
}
