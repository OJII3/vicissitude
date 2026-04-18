import type { FetchedImage, ImageFetcher } from "@vicissitude/shared/ports";
import type { Logger } from "@vicissitude/shared/types";

/** Claude API の画像入力上限に合わせた既定サイズ上限（5 MiB）。 */
export const DEFAULT_MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

/** wait_for_events のレスポンスを過度に遅らせないための fetch タイムアウト（ms）。 */
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

const IMAGE_MIME_PREFIX = "image/";

/**
 * `typeof fetch` には Bun/Node 固有の `preconnect` 等が含まれ、
 * テスト用スタブの型付けが煩雑になるので、本ファイルが実際に呼び出す形だけに限定する。
 */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface CreateHttpImageFetcherOptions {
	logger?: Logger;
	/** 個別 fetch のタイムアウト（ms）。省略時 {@link DEFAULT_FETCH_TIMEOUT_MS}。 */
	timeoutMs?: number;
	/** 許容する画像バイトの最大サイズ。省略時 {@link DEFAULT_MAX_IMAGE_SIZE_BYTES}。 */
	maxSizeBytes?: number;
	/** fetch 実装の差し替え口（テスト用）。 */
	fetchFn?: FetchLike;
}

/**
 * `fetch` で URL を取得し base64 + MIME type に変換する {@link ImageFetcher} を生成する。
 * 失敗時は例外を投げず `null` を返す（上位は filename 等の text 表記にフォールバック）。
 */
export function createHttpImageFetcher(options: CreateHttpImageFetcherOptions = {}): ImageFetcher {
	const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_IMAGE_SIZE_BYTES;
	const logger = options.logger;
	const fetchFn = options.fetchFn ?? fetch;

	return async (url: string): Promise<FetchedImage | null> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetchFn(url, { signal: controller.signal });
			if (!res.ok) {
				logger?.warn(`[image-fetcher] HTTP ${res.status} for ${url}`);
				return null;
			}
			const rawContentType = res.headers.get("content-type") ?? "";
			const mimeType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
			// "image/" だけ（subtype 空）も MCP / Claude が受け付けないので拒否する
			if (!mimeType.startsWith(IMAGE_MIME_PREFIX) || mimeType.length <= IMAGE_MIME_PREFIX.length) {
				logger?.warn(
					`[image-fetcher] non-image content-type: ${rawContentType || "(empty)"} (${url})`,
				);
				return null;
			}
			const contentLengthHeader = res.headers.get("content-length");
			if (contentLengthHeader) {
				const cl = Number(contentLengthHeader);
				if (Number.isFinite(cl) && cl > maxSize) {
					logger?.warn(`[image-fetcher] too large (content-length=${cl}): ${url}`);
					return null;
				}
			}
			const buf = await res.arrayBuffer();
			if (buf.byteLength > maxSize) {
				logger?.warn(`[image-fetcher] too large (body=${buf.byteLength}): ${url}`);
				return null;
			}
			const base64 = Buffer.from(buf).toString("base64");
			return { base64, mimeType };
		} catch (err) {
			logger?.warn(`[image-fetcher] fetch failed: ${url}`, err);
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
