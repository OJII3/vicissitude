import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { GeniusClient } from "@vicissitude/listening/genius-client";

// --- helpers ---

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		return responder(urlStr, init);
	}) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function htmlResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html" },
	});
}

function searchBody(url: string | null): unknown {
	return {
		response: {
			hits: url === null ? [] : [{ result: { id: 1, url } }],
		},
	};
}

/** search API は固定 URL を返し、scrape 対象の HTML だけを差し替えるヘルパー */
function installScrapeResponse(html: string): void {
	installFetch((url) => {
		if (url.startsWith("https://api.genius.com/")) {
			return Promise.resolve(jsonResponse(searchBody("https://genius.com/song")));
		}
		return Promise.resolve(htmlResponse(html));
	});
}

// --- tests ---

describe("GeniusClient.fetchLyrics — 歌詞抽出の仕様", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// ============================================================
	// 回帰防止: 既存の基本的な振る舞い
	// ============================================================

	it("単一の lyrics container からテキストを抽出する", async () => {
		installScrapeResponse(
			'<html><body><div data-lyrics-container="true">こんにちは世界</div></body></html>',
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBe("こんにちは世界");
	});

	it("複数の lyrics container を改行で連結する", async () => {
		installScrapeResponse(
			'<div data-lyrics-container="true">一番</div>' +
				'<div data-lyrics-container="true">二番</div>',
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBe("一番\n二番");
	});

	it("<br> / <br/> タグは改行に変換される", async () => {
		installScrapeResponse('<div data-lyrics-container="true">行1<br>行2<br/>行3</div>');

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBe("行1\n行2\n行3");
	});

	it("内部の HTML タグは除去される", async () => {
		installScrapeResponse(
			'<div data-lyrics-container="true">前<span class="x">真ん中</span>後</div>',
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBe("前真ん中後");
	});

	// ============================================================
	// Issue #509: ネストした div による歌詞欠損
	// ============================================================

	it("lyrics container 内にネストした div がある場合でも歌詞全体が取得される", async () => {
		// Genius の実際の HTML では lyrics container 内に
		// <div class="SongPageGrid-..."> などのネスト div が存在する
		installScrapeResponse(
			'<div data-lyrics-container="true">' +
				"[Verse 1]<br>" +
				'<div class="section">' +
				"最初の行<br>次の行" +
				"</div>" +
				"[Chorus]<br>" +
				"サビの歌詞" +
				"</div>",
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).not.toBeNull();
		expect(result).toContain("[Verse 1]");
		expect(result).toContain("最初の行");
		expect(result).toContain("次の行");
		expect(result).toContain("[Chorus]");
		expect(result).toContain("サビの歌詞");
	});

	it("複数階層のネスト div でも歌詞が完全に取得される", async () => {
		// div > div > div のような深いネスト構造
		installScrapeResponse(
			'<div data-lyrics-container="true">' +
				'<div class="outer">' +
				'<div class="inner">' +
				"深い階層の歌詞" +
				"</div>" +
				"外側の歌詞" +
				"</div>" +
				"最外の歌詞" +
				"</div>",
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).not.toBeNull();
		expect(result).toContain("深い階層の歌詞");
		expect(result).toContain("外側の歌詞");
		expect(result).toContain("最外の歌詞");
	});

	it("ネスト div と複数 container の組み合わせでも歌詞が完全に取得される", async () => {
		installScrapeResponse(
			'<div data-lyrics-container="true">' +
				'<div class="section">[Verse 1]<br>歌詞A</div>' +
				"</div>" +
				'<div data-lyrics-container="true">' +
				'<div class="section">[Verse 2]<br>歌詞B</div>' +
				"</div>",
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).not.toBeNull();
		expect(result).toContain("[Verse 1]");
		expect(result).toContain("歌詞A");
		expect(result).toContain("[Verse 2]");
		expect(result).toContain("歌詞B");
	});
});
