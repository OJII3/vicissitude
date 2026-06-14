import { describe, expect, test } from "bun:test";

import {
	fetchJsonWithTimeout,
	fetchWithTimeout,
	type FetchLike,
	type SafeParseable,
} from "@vicissitude/shared/http";
import { z } from "zod";

/** 指定ステータス・JSON body の Response を返す stub fetch */
function stubFetch(body: unknown, status = 200): FetchLike {
	return () =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
}

/** 即時 reject する stub fetch */
function rejectingFetch(message: string): FetchLike {
	return () => Promise.reject(new Error(message));
}

/** JSON として不正な body を返す stub fetch */
const malformedJsonFetch: FetchLike = () =>
	Promise.resolve(
		new Response("not-json", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);

/** signal が abort されるまで pending し、abort で TimeoutError を投げる stub fetch */
const abortAwareFetch: FetchLike = (_url, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => {
			reject(new DOMException("timeout", "TimeoutError"));
		});
	});

describe("fetchWithTimeout", () => {
	test("正常系: fetchFn の Response をそのまま解決する", async () => {
		const res = new Response("ok", { status: 200 });
		const fetchFn: FetchLike = () => Promise.resolve(res);

		const result = await fetchWithTimeout(fetchFn, "https://example.com", 1000);

		expect(result).toBe(res);
	});

	test("fetchFn に渡される URL は呼び出し時の URL である", async () => {
		let receivedUrl: string | undefined;
		const fetchFn: FetchLike = (url) => {
			receivedUrl = url;
			return Promise.resolve(new Response("ok"));
		};

		await fetchWithTimeout(fetchFn, "https://example.com/path", 1000);

		expect(receivedUrl).toBe("https://example.com/path");
	});

	test("fetchFn には abort 可能な AbortSignal が渡される", async () => {
		let receivedSignal: AbortSignal | undefined;
		const fetchFn: FetchLike = (_url, init) => {
			receivedSignal = init?.signal;
			return Promise.resolve(new Response("ok"));
		};

		await fetchWithTimeout(fetchFn, "https://example.com", 1000);

		expect(receivedSignal).toBeInstanceOf(AbortSignal);
	});

	test("タイムアウト経過後に signal が abort される", async () => {
		let receivedSignal: AbortSignal | undefined;
		// signal を捕捉しつつ即座に解決する（fetch 自体はタイムアウト前に終わる想定）
		const fetchFn: FetchLike = (_url, init) => {
			receivedSignal = init?.signal;
			return Promise.resolve(new Response("ok"));
		};

		await fetchWithTimeout(fetchFn, "https://example.com", 10);
		expect(receivedSignal?.aborted).toBe(false);

		// タイムアウト時間を超えて待つと signal が abort される
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 30);
		});
		expect(receivedSignal?.aborted).toBe(true);
	});

	test("fetchFn が reject した場合は例外をそのまま伝播する", () => {
		const promise = fetchWithTimeout(rejectingFetch("ECONNRESET"), "https://example.com", 1000);

		expect(promise).rejects.toThrow("ECONNRESET");
	});
});

const TestSchema = z.object({
	code: z.number(),
	value: z.string(),
});

describe("fetchJsonWithTimeout", () => {
	test("正常系: zod schema を渡すと構造的に通り parse 済みデータを返す", async () => {
		const fetchFn = stubFetch({ code: 200, value: "hello" });

		// zod の ZodType は構造的に SafeParseable<T> を満たす（zod バージョン非依存）
		const result = await fetchJsonWithTimeout(fetchFn, "https://example.com", TestSchema, 1000);

		expect(result).toEqual({ code: 200, value: "hello" });
	});

	test("zod 非依存の素の SafeParseable オブジェクトでも動く", async () => {
		const fetchFn = stubFetch({ id: 7, label: "ok" });
		// safeParse だけを実装した自前バリデータ（zod に一切依存しない）
		const schema: SafeParseable<{ id: number; label: string }> = {
			safeParse(data) {
				if (
					typeof data === "object" &&
					data !== null &&
					typeof (data as { id?: unknown }).id === "number" &&
					typeof (data as { label?: unknown }).label === "string"
				) {
					return { success: true, data: data as { id: number; label: string } };
				}
				return { success: false };
			},
		};

		const result = await fetchJsonWithTimeout(fetchFn, "https://example.com", schema, 1000);

		expect(result).toEqual({ id: 7, label: "ok" });
	});

	test("res.ok が false の場合は null を返す", async () => {
		const fetchFn = stubFetch({ code: 404, value: "x" }, 404);

		const result = await fetchJsonWithTimeout(fetchFn, "https://example.com", TestSchema, 1000);

		expect(result).toBeNull();
	});

	test("JSON parse に失敗した場合は null を返す", async () => {
		const result = await fetchJsonWithTimeout(
			malformedJsonFetch,
			"https://example.com",
			TestSchema,
			1000,
		);

		expect(result).toBeNull();
	});

	test("schema 検証に失敗した場合は null を返す", async () => {
		// code が string で schema (number) に不適合
		const fetchFn = stubFetch({ code: "200", value: "hello" });

		const result = await fetchJsonWithTimeout(fetchFn, "https://example.com", TestSchema, 1000);

		expect(result).toBeNull();
	});

	test("fetchFn が reject した場合も例外を投げず null を返す", async () => {
		const result = await fetchJsonWithTimeout(
			rejectingFetch("network down"),
			"https://example.com",
			TestSchema,
			1000,
		);

		expect(result).toBeNull();
	});

	test("タイムアウトで fetchFn が reject しても null を返す", async () => {
		const start = Date.now();
		const result = await fetchJsonWithTimeout(
			abortAwareFetch,
			"https://example.com",
			TestSchema,
			20,
		);
		const elapsed = Date.now() - start;

		expect(result).toBeNull();
		expect(elapsed).toBeLessThan(1000);
	});
});
