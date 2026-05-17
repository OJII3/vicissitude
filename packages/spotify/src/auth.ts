import { z } from "zod";

import {
	createSpotifyRuntimeDeps,
	type SpotifyRuntimeDeps,
	type SpotifyRuntimeDepsInput,
} from "./runtime-deps.ts";
import { spotifyNonEmptyStringSchema } from "./types.ts";

export interface SpotifyAuthPort {
	getAccessToken(): Promise<string>;
}

/** Spotify パッケージ共通の最小ロガーポート */
export interface SpotifyLogger {
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

interface TokenCache {
	accessToken: string;
	expiresAt: number;
}

const tokenResponseSchema = z.object({
	access_token: spotifyNonEmptyStringSchema,
	expires_in: z.number().int().min(0),
});

export class SpotifyAuth implements SpotifyAuthPort {
	private cache: TokenCache | null = null;
	private inFlightToken: Promise<TokenCache> | null = null;
	private readonly deps: SpotifyRuntimeDeps;

	constructor(
		private readonly config: {
			clientId: string;
			clientSecret: string;
			refreshToken: string;
		},
		private readonly logger?: SpotifyLogger,
		deps: SpotifyRuntimeDepsInput = {},
	) {
		this.deps = createSpotifyRuntimeDeps(deps);
	}

	private async fetchToken(): Promise<TokenCache> {
		const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);
		const response = await this.deps.fetch("https://accounts.spotify.com/api/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${credentials}`,
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: this.config.refreshToken,
			}),
			signal: this.deps.timeoutSignal(10_000),
		});

		if (!response.ok) {
			const msg = `Spotify token request failed: ${response.status} ${response.statusText}`;
			this.logger?.error(`[spotify:auth] ${msg}`);
			throw new Error(msg);
		}

		const data = tokenResponseSchema.parse(await response.json());

		this.logger?.info(`[spotify:auth] トークン取得成功 (expires_in=${data.expires_in}s)`);

		return {
			accessToken: data.access_token,
			expiresAt: this.deps.now() + data.expires_in * 1000,
		};
	}

	async getAccessToken(): Promise<string> {
		if (this.cache && this.deps.now() < this.cache.expiresAt) {
			return this.cache.accessToken;
		}

		this.inFlightToken ??= this.fetchToken();

		try {
			this.cache = await this.inFlightToken;
			return this.cache.accessToken;
		} finally {
			this.inFlightToken = null;
		}
	}
}
