const GENIUS_API_BASE = "https://api.genius.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export type GeniusFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GeniusTimeout = (milliseconds: number) => AbortSignal;

export interface GeniusClientOptions {
	fetch?: GeniusFetch;
	timeout?: GeniusTimeout;
	timeoutMs?: number;
	baseUrl?: string;
}

interface GeniusSearchResponse {
	response: {
		hits: Array<{
			result: {
				id: number;
				url: string;
			};
		}>;
	};
}

/**
 * Genius API 経由で歌詞を取得するクライアント。
 *
 * Genius API 本体は曲の URL までしか返さないため、歌詞本文は
 * Web ページ HTML からスクレイピングする必要がある。ここでは
 * シンプルに HTML 取得 → lyrics container タグ抽出で実装する。
 */
export class GeniusClient {
	private readonly fetch: GeniusFetch;
	private readonly timeout: GeniusTimeout;
	private readonly timeoutMs: number;
	private readonly baseUrl: string;

	constructor(
		private readonly accessToken: string,
		options: GeniusClientOptions = {},
	) {
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.timeout = options.timeout ?? ((milliseconds) => AbortSignal.timeout(milliseconds));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.baseUrl = normalizeBaseUrl(options.baseUrl ?? GENIUS_API_BASE);
	}

	async fetchLyrics(title: string, artist: string): Promise<string | null> {
		const query = `${title} ${artist}`;
		const url = await this.searchSongUrl(query);
		if (!url) return null;
		return this.scrapeLyrics(url);
	}

	private async searchSongUrl(query: string): Promise<string | null> {
		const response = await this.fetch(`${this.baseUrl}/search?q=${encodeURIComponent(query)}`, {
			headers: { Authorization: `Bearer ${this.accessToken}` },
			signal: this.timeout(this.timeoutMs),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as GeniusSearchResponse;
		return data.response.hits[0]?.result.url ?? null;
	}

	private async scrapeLyrics(url: string): Promise<string | null> {
		const response = await this.fetch(url, { signal: this.timeout(this.timeoutMs) });
		if (!response.ok) return null;
		const html = await response.text();
		// Genius は lyrics を <div data-lyrics-container="true">...</div> に入れる
		// ネストした div がある場合に備え、深さカウントで対応する閉じタグを特定する
		const contents: string[] = [];
		const openPattern = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
		let openMatch: RegExpExecArray | null;
		while ((openMatch = openPattern.exec(html)) !== null) {
			const contentStart = openMatch.index + openMatch[0].length;
			let depth = 1;
			const divTagPattern = /<\/?div[\s>]/gi;
			divTagPattern.lastIndex = contentStart;
			let tagMatch: RegExpExecArray | null;
			while (depth > 0 && (tagMatch = divTagPattern.exec(html)) !== null) {
				if (tagMatch[0].startsWith("</")) {
					depth--;
					if (depth === 0) {
						contents.push(html.slice(contentStart, tagMatch.index));
					}
				} else {
					depth++;
				}
			}
		}
		if (contents.length === 0) return null;
		const raw = contents.join("\n");
		return raw
			.replaceAll(/<br\s*\/?>/g, "\n")
			.replaceAll(/<[^>]+>/g, "")
			.replaceAll("&amp;", "&")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&quot;", '"')
			.replaceAll("&#x27;", "'")
			.trim();
	}
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replaceAll(/\/+$/g, "");
}
