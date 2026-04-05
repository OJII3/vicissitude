import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { GeniusClient } from "./genius-client.ts";

type FetchCall = {
	url: string;
	init: RequestInit | undefined;
};

function installFetch(
	responder: (url: string, init?: RequestInit) => Promise<Response>,
): FetchCall[] {
	const calls: FetchCall[] = [];
	globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		calls.push({ url: urlStr, init });
		return responder(urlStr, init);
	}) as unknown as typeof fetch;
	return calls;
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

describe("GeniusClient.fetchLyrics — URL / クエリ構築", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("検索クエリは `${title} ${artist}` を encodeURIComponent したもの", async () => {
		const calls = installFetch((url) => {
			if (url.startsWith("https://api.genius.com/search")) {
				return Promise.resolve(jsonResponse(searchBody(null)));
			}
			return Promise.resolve(htmlResponse(""));
		});

		const client = new GeniusClient("token-x");
		await client.fetchLyrics("夜に駆ける", "YOASOBI");

		const expected = `https://api.genius.com/search?q=${encodeURIComponent("夜に駆ける YOASOBI")}`;
		expect(calls[0]?.url).toBe(expected);
	});

	it("title / artist に空白や記号が含まれていても URL エンコードされる", async () => {
		const calls = installFetch(() => Promise.resolve(jsonResponse(searchBody(null))));

		const client = new GeniusClient("t");
		await client.fetchLyrics("Let It Be", "The Beatles & Friends");

		expect(calls[0]?.url).toContain(encodeURIComponent("Let It Be The Beatles & Friends"));
	});

	it("search API 呼び出しには Authorization: Bearer <token> ヘッダーが付く", async () => {
		const calls = installFetch(() => Promise.resolve(jsonResponse(searchBody(null))));

		const client = new GeniusClient("my-access-token");
		await client.fetchLyrics("曲", "アーティスト");

		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer my-access-token");
	});
});

describe("GeniusClient.fetchLyrics — 検索レスポンスの解析", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("hits が空配列の場合 null を返す（scrape は呼ばれない）", async () => {
		let searchCount = 0;
		let scrapeCount = 0;
		installFetch((url) => {
			if (url.startsWith("https://api.genius.com/")) {
				searchCount++;
				return Promise.resolve(jsonResponse(searchBody(null)));
			}
			scrapeCount++;
			return Promise.resolve(htmlResponse("<html></html>"));
		});

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBeNull();
		expect(searchCount).toBe(1);
		expect(scrapeCount).toBe(0);
	});

	it("hits の先頭(result.url)を使用して scrape を行う", async () => {
		const calls = installFetch((url) => {
			if (url.startsWith("https://api.genius.com/")) {
				return Promise.resolve(
					jsonResponse({
						response: {
							hits: [
								{ result: { id: 1, url: "https://genius.com/first" } },
								{ result: { id: 2, url: "https://genius.com/second" } },
							],
						},
					}),
				);
			}
			return Promise.resolve(htmlResponse('<div data-lyrics-container="true">lyrics body</div>'));
		});

		const client = new GeniusClient("t");
		await client.fetchLyrics("曲", "A");

		expect(calls[1]?.url).toBe("https://genius.com/first");
	});

	it("search API が非 200 を返した場合 null を返す", async () => {
		installFetch(() => Promise.resolve(new Response(JSON.stringify({}), { status: 500 })));

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");
		expect(result).toBeNull();
	});

	it("search API が 404 を返した場合 null を返す", async () => {
		installFetch(() => Promise.resolve(new Response("", { status: 404 })));

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");
		expect(result).toBeNull();
	});
});

describe("GeniusClient.fetchLyrics — 歌詞 scrape / 抽出", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function installScrapeResponse(html: string, status = 200): void {
		installFetch((url) => {
			if (url.startsWith("https://api.genius.com/")) {
				return Promise.resolve(jsonResponse(searchBody("https://genius.com/song")));
			}
			return Promise.resolve(htmlResponse(html, status));
		});
	}

	it("data-lyrics-container=true の div 内テキストを抽出する", async () => {
		installScrapeResponse(
			'<html><body><div data-lyrics-container="true">こんにちは世界</div></body></html>',
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBe("こんにちは世界");
	});

	it("複数の data-lyrics-container div を改行で連結する", async () => {
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

	it("HTML エンティティ (&amp; &lt; &gt; &quot; &#x27;) をデコードする", async () => {
		installScrapeResponse(
			'<div data-lyrics-container="true">A &amp; B &lt;c&gt; &quot;d&quot; &#x27;e&#x27;</div>',
		);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBe(`A & B <c> "d" 'e'`);
	});

	it("結果は trim される（前後空白が除去される）", async () => {
		installScrapeResponse('<div data-lyrics-container="true">   \n  歌詞本文  \n   </div>');

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBe("歌詞本文");
	});

	it("lyrics container が存在しない場合 null を返す", async () => {
		installScrapeResponse("<html><body><div>nothing to see</div></body></html>");

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBeNull();
	});

	it("scrape が非 200 を返した場合 null を返す", async () => {
		installScrapeResponse("", 500);

		const client = new GeniusClient("t");
		const result = await client.fetchLyrics("曲", "A");

		expect(result).toBeNull();
	});
});

describe("GeniusClient.fetchLyrics — ネットワークエラー", () => {
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("search API の fetch が throw した場合 エラーは伝播する", async () => {
		installFetch(() => Promise.reject(new Error("network down")));

		const client = new GeniusClient("t");
		await expect(client.fetchLyrics("曲", "A")).rejects.toThrow("network down");
	});

	it("scrape の fetch が throw した場合 エラーは伝播する", async () => {
		installFetch((url) => {
			if (url.startsWith("https://api.genius.com/")) {
				return Promise.resolve(jsonResponse(searchBody("https://genius.com/song")));
			}
			return Promise.reject(new Error("scrape failure"));
		});

		const client = new GeniusClient("t");
		await expect(client.fetchLyrics("曲", "A")).rejects.toThrow("scrape failure");
	});
});
