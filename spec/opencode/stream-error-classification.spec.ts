/**
 * セッションエラー検知改善: stream.next() エラーの原因区別の仕様テスト
 *
 * 期待仕様:
 * 1. StreamReadResult に streamError タイプが追加される
 * 2. タイムアウトエラーは streamTimeout として分類される
 * 3. ネットワークエラー等の非タイムアウトエラーは streamError として分類される
 * 4. streamError には reason が含まれる
 */
import { describe, expect, mock, test } from "bun:test";

import { type AbortableAsyncStream, nextStreamEvent } from "@vicissitude/opencode/stream-helpers";

// ─── streamTimeout vs streamError の区別 ────────────────────────

describe("nextStreamEvent: エラー原因の区別", () => {
	test("stream.next() がタイムアウトで reject した場合、{ type: 'streamTimeout' } を返す", async () => {
		const stream = {
			next: mock(
				() =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 5);
					}),
			),
		} as AbortableAsyncStream<unknown>;

		const result = await nextStreamEvent(
			stream,
			undefined,
			mock(() => Promise.resolve()),
		);

		expect(result.type).toBe("streamTimeout");
		if (result.type !== "streamTimeout") throw new Error("unreachable");
		expect(result.reason).toContain("timed out");
	});

	test("stream.next() がネットワークエラーで reject した場合、{ type: 'streamError' } を返す", async () => {
		const stream = {
			next: mock(
				() =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("ECONNRESET: connection reset by peer")), 5);
					}),
			),
		} as AbortableAsyncStream<unknown>;

		const result = await nextStreamEvent(
			stream,
			undefined,
			mock(() => Promise.resolve()),
		);

		expect(result.type).toBe("streamError");
		if (result.type !== "streamError") throw new Error("unreachable");
		expect(result.reason).toContain("ECONNRESET");
	});

	test("stream.next() が不明なエラーで reject した場合、{ type: 'streamError' } を返す", async () => {
		const stream = {
			next: mock(
				() =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("unexpected failure")), 5);
					}),
			),
		} as AbortableAsyncStream<unknown>;

		const result = await nextStreamEvent(
			stream,
			undefined,
			mock(() => Promise.resolve()),
		);

		expect(result.type).toBe("streamError");
		if (result.type !== "streamError") throw new Error("unreachable");
		expect(result.reason).toContain("unexpected failure");
	});

	test("signal 付きでネットワークエラーの場合も { type: 'streamError' } を返す", async () => {
		const stream = {
			next: mock(
				() =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("EPIPE: broken pipe")), 5);
					}),
			),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		} as AbortableAsyncStream<unknown>;

		const result = await nextStreamEvent(
			stream,
			new AbortController().signal,
			mock(() => Promise.resolve()),
		);

		expect(result.type).toBe("streamError");
		if (result.type !== "streamError") throw new Error("unreachable");
		expect(result.reason).toContain("EPIPE");
	});

	test("signal 付きでタイムアウトの場合は { type: 'streamTimeout' } を返す", async () => {
		const stream = {
			next: mock(
				() =>
					new Promise((_resolve, reject) => {
						setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 5);
					}),
			),
			return: mock(() => Promise.resolve({ done: true as const, value: undefined })),
		} as AbortableAsyncStream<unknown>;

		const result = await nextStreamEvent(
			stream,
			new AbortController().signal,
			mock(() => Promise.resolve()),
		);

		expect(result.type).toBe("streamTimeout");
		if (result.type !== "streamTimeout") throw new Error("unreachable");
		expect(result.reason).toContain("timed out");
	});
});
