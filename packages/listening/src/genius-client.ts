const GENIUS_API_BASE = "https://api.genius.com";

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
	constructor(private readonly accessToken: string) {}

	async fetchLyrics(title: string, artist: string): Promise<string | null> {
		const query = `${title} ${artist}`;
		const url = await this.searchSongUrl(query);
		if (!url) return null;
		return this.scrapeLyrics(url);
	}

	private async searchSongUrl(query: string): Promise<string | null> {
		const response = await fetch(`${GENIUS_API_BASE}/search?q=${encodeURIComponent(query)}`, {
			headers: { Authorization: `Bearer ${this.accessToken}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as GeniusSearchResponse;
		return data.response.hits[0]?.result.url ?? null;
	}

	private async scrapeLyrics(url: string): Promise<string | null> {
		const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return null;
		const html = await response.text();
		// Genius は lyrics を <div data-lyrics-container="true">...</div> に入れる
		const matches = [
			...html.matchAll(/<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g),
		];
		if (matches.length === 0) return null;
		const raw = matches.map((m) => m[1] ?? "").join("\n");
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
