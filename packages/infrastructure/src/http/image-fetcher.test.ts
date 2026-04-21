import { describe, expect, test } from "bun:test";

import {
	HttpImageFetcher,
	DEFAULT_MAX_IMAGE_SIZE_BYTES,
	type FetchLike,
	type FetchedImage,
} from "./image-fetcher.ts";

/** base64 文字列を復号してバイト長を返す */
function base64ByteLength(b64: string): number {
	// eslint-disable-next-line no-undef
	return Buffer.from(b64, "base64").byteLength;
}

function makeResponse(
	body: ArrayBuffer | Uint8Array,
	init: { status?: number; contentType?: string; contentLength?: number | null } = {},
): Response {
	const headers = new Headers();
	if (init.contentType !== undefined) headers.set("content-type", init.contentType);
	if (init.contentLength !== null && init.contentLength !== undefined) {
		headers.set("content-length", String(init.contentLength));
	}
	// new ArrayBuffer + set でコピーすることで SharedArrayBuffer 型混入を回避
	const buf = body instanceof Uint8Array ? new ArrayBuffer(body.byteLength) : body;
	if (body instanceof Uint8Array) new Uint8Array(buf).set(body);
	return new Response(buf, {
		status: init.status ?? 200,
		headers,
	});
}

/** null を排除してテスト本体を簡潔に書くためのアサーションヘルパー */
function expectFetched(result: FetchedImage | null): FetchedImage {
	if (result === null) throw new Error("expected fetched image, got null");
	return result;
}

const stubFetch = (response: Response): FetchLike => {
	return () => Promise.resolve(response);
};

describe("HttpImageFetcher", () => {
	test("正常系: image/png を base64 + MIME type に変換する", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const fetcher = new HttpImageFetcher({
			fetchFn: stubFetch(makeResponse(bytes, { contentType: "image/png" })),
		});
		const result = expectFetched(await fetcher.fetch("https://example.com/a.png"));

		expect(result.mimeType).toBe("image/png");
		expect(base64ByteLength(result.base64)).toBe(bytes.byteLength);
	});

	test("Content-Type パラメータ (charset 等) を除いて MIME type を抽出する", async () => {
		const fetcher = new HttpImageFetcher({
			fetchFn: stubFetch(
				makeResponse(new Uint8Array([1, 2, 3]), { contentType: "image/jpeg; charset=binary" }),
			),
		});
		const result = expectFetched(await fetcher.fetch("https://example.com/a.jpg"));

		expect(result.mimeType).toBe("image/jpeg");
	});

	test("HTTP エラー (4xx/5xx) は null を返す", async () => {
		const fetcher = new HttpImageFetcher({
			fetchFn: stubFetch(makeResponse(new Uint8Array(), { status: 404, contentType: "image/png" })),
		});
		expect(await fetcher.fetch("https://example.com/missing.png")).toBeNull();
	});

	test("非画像 MIME (application/pdf 等) は null を返す", async () => {
		const fetcher = new HttpImageFetcher({
			fetchFn: stubFetch(makeResponse(new Uint8Array([1]), { contentType: "application/pdf" })),
		});
		expect(await fetcher.fetch("https://example.com/doc.pdf")).toBeNull();
	});

	test("Content-Type ヘッダ欠落時は null を返す", async () => {
		const fetcher = new HttpImageFetcher({
			fetchFn: stubFetch(makeResponse(new Uint8Array([1]), {})),
		});
		expect(await fetcher.fetch("https://example.com/?")).toBeNull();
	});

	test("Content-Length が上限を超えている場合は body を読まずに null を返す", async () => {
		// arrayBuffer() を直接スパイすることで「body 読み取りが回避された」ことを検証する。
		// (Bun の Response は ReadableStream を eager に consume する場合があるため
		// stream callback でのトラッキングは信頼できない。)
		let arrayBufferCalled = false;
		const fetchFn: FetchLike = () => {
			const headers = new Headers({
				"content-type": "image/png",
				"content-length": String(DEFAULT_MAX_IMAGE_SIZE_BYTES + 1),
			});
			const res = new Response(new Uint8Array([1, 2, 3]).buffer, { headers });
			const original = res.arrayBuffer.bind(res);
			res.arrayBuffer = () => {
				arrayBufferCalled = true;
				return original();
			};
			return Promise.resolve(res);
		};

		const fetcher = new HttpImageFetcher({ fetchFn });
		expect(await fetcher.fetch("https://example.com/big.png")).toBeNull();
		expect(arrayBufferCalled).toBe(false);
	});

	test("body 実サイズが上限を超える場合も null を返す (Content-Length 偽装対策)", async () => {
		const big = new Uint8Array(10);
		const fetcher = new HttpImageFetcher({
			fetchFn: stubFetch(makeResponse(big, { contentType: "image/png", contentLength: null })),
			maxSizeBytes: 5,
		});
		expect(await fetcher.fetch("https://example.com/big.png")).toBeNull();
	});

	test("fetch が例外を投げた場合は null を返す (例外を伝播させない)", async () => {
		const fetcher = new HttpImageFetcher({
			fetchFn: () => Promise.reject(new Error("ECONNRESET")),
		});
		expect(await fetcher.fetch("https://example.com/a.png")).toBeNull();
	});

	test("タイムアウト時は AbortError で null を返す", async () => {
		const fetcher = new HttpImageFetcher({
			fetchFn: (_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					if (signal) {
						signal.addEventListener("abort", () => {
							reject(new DOMException("aborted", "AbortError"));
						});
					}
				}),
			timeoutMs: 20,
		});
		const start = Date.now();
		const result = await fetcher.fetch("https://example.com/slow.png");
		const elapsed = Date.now() - start;

		expect(result).toBeNull();
		// 20ms タイムアウトが有効に働いていることの粗い証拠
		expect(elapsed).toBeLessThan(1000);
	});
});
