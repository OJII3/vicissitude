export interface SpotifyAuthPort {
	getAccessToken(): Promise<string>;
}

export interface SpotifyAuthLogger {
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
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
		private readonly logger?: SpotifyAuthLogger,
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
			const msg = `Spotify token request failed: ${response.status} ${response.statusText}`;
			this.logger?.error(`[spotify:auth] ${msg}`);
			throw new Error(msg);
		}

		const data = (await response.json()) as {
			access_token: string;
			expires_in: number;
		};

		this.logger?.info(`[spotify:auth] トークン取得成功 (expires_in=${data.expires_in}s)`);

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
