/* oxlint-disable max-lines, max-lines-per-function -- テストファイルはケース数に応じて長くなるため許容 */
import { describe, expect, mock, test } from "bun:test";

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { OpencodeSessionAdapter } from "./session-adapter.ts";
type AbortListener = (...args: unknown[]) => void;

function deferred<T>() {
	let resolveDeferred!: (value: T) => void;
	let rejectDeferred!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolveDeferred = resolve;
		rejectDeferred = reject;
	});
	return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function createStream() {
	const pending = deferred<IteratorResult<Event, void>>();
	let current = pending;
	const stream = {
		next: mock(() => current.promise),
		return: mock((value?: unknown) => {
			current.resolve({ done: true, value: undefined });
			return Promise.resolve({ done: true, value: value as void });
		}),
		[Symbol.asyncIterator]() {
			return this;
		},
	};
	return {
		stream: stream as unknown as AsyncGenerator<Event, void, unknown>,
		returnMock: stream.return,
		push(event: Event) {
			current.resolve({ done: false, value: event });
			current = deferred<IteratorResult<Event, void>>();
		},
	};
}

function createTrackedSignal(controller: AbortController) {
	const listeners = new Set<AbortListener>();
	return {
		signal: {
			get aborted() {
				return controller.signal.aborted;
			},
			addEventListener(type: string, listener: AbortListener) {
				if (type === "abort") listeners.add(listener);
				controller.signal.addEventListener(type, listener);
			},
			removeEventListener(type: string, listener: AbortListener) {
				if (type === "abort") listeners.delete(listener);
				controller.signal.removeEventListener(type, listener);
			},
		} as unknown as AbortSignal,
		listenerCount: () => listeners.size,
	};
}

function createClient(stream: AsyncGenerator<Event, void, unknown>) {
	const client = {
		event: {
			subscribe: mock(() => Promise.resolve({ stream })),
		},
		session: {
			create: mock(() => Promise.resolve({ data: { id: "session-1" }, error: null })),
			get: mock(() => Promise.resolve({ data: null, error: { message: "missing" } })),
			prompt: mock(() => Promise.resolve({ data: { parts: [], info: {} }, error: null })),
			promptAsync: mock(() => Promise.resolve({ data: {}, error: null })),
			abort: mock(() => Promise.resolve({ data: {}, error: null })),
			delete: mock(() => Promise.resolve({ data: {}, error: null })),
		},
	};
	return client as unknown as OpencodeClient & {
		session: {
			abort: ReturnType<typeof mock>;
		};
	};
}

function createAdapter(client: OpencodeClient): OpencodeSessionAdapter {
	return new OpencodeSessionAdapter({
		port: 4096,
		mcpServers: {},
		builtinTools: {},
		clientFactory: mock(() =>
			Promise.resolve({
				client,
				server: { url: "http://localhost", close: mock(() => {}) },
			}),
		),
	});
}

describe("OpencodeSessionAdapter", () => {
	test("OpenCode 起動時に agent config と primary_tools を渡す", async () => {
		const streamState = createStream();
		const client = createClient(streamState.stream);
		const clientFactory = mock(() =>
			Promise.resolve({
				client,
				server: { url: "http://localhost", close: mock(() => {}) },
			}),
		);
		const adapter = new OpencodeSessionAdapter({
			port: 4096,
			mcpServers: {},
			builtinTools: { task: true },
			agents: {
				build: { mode: "primary", tools: { shell_exec: false } },
				"shell-worker": {
					mode: "subagent",
					model: "provider/worker-model",
					tools: { shell_exec: true },
				},
			},
			defaultAgent: "build",
			primaryTools: ["task"],
			temperature: 0.9,
			clientFactory,
		});

		await adapter.createSession("test session");

		expect(clientFactory).toHaveBeenCalledTimes(1);
		const calls = clientFactory.mock.calls as unknown as Array<[unknown]>;
		const options = calls[0]?.[0] as {
			config: {
				default_agent?: string;
				agent?: Record<string, { temperature?: number; mode?: string }>;
				experimental?: { primary_tools?: string[] };
			};
		};
		expect(options.config.default_agent).toBe("build");
		expect(options.config.experimental?.primary_tools).toEqual(["task"]);
		expect(options.config.agent?.build?.mode).toBe("primary");
		expect(options.config.agent?.build?.temperature).toBe(0.9);
		expect(options.config.agent?.["shell-worker"]?.mode).toBe("subagent");
	});

	test("promptAsyncAndWatchSession は abort 時に次イベントを待たず cancelled を返す", async () => {
		const streamState = createStream();
		const client = createClient(streamState.stream);
		const adapter = createAdapter(client as unknown as OpencodeClient);
		const controller = new AbortController();
		const watch = adapter.promptAsyncAndWatchSession(
			{
				sessionId: "session-1",
				text: "watch",
				model: { providerId: "provider", modelId: "model" },
			},
			controller.signal,
		);

		controller.abort();

		await expect(watch).resolves.toEqual({ type: "cancelled" });
		expect(client.session.abort).toHaveBeenCalledWith({ sessionID: "session-1" });
		expect(streamState.returnMock).toHaveBeenCalled();
	});

	test("waitForSessionIdle も abort 時に次イベントを待たず cancelled を返す", async () => {
		const streamState = createStream();
		const client = createClient(streamState.stream);
		const adapter = createAdapter(client as unknown as OpencodeClient);
		const controller = new AbortController();
		const watch = adapter.waitForSessionIdle("session-1", controller.signal);
		controller.abort();
		await expect(watch).resolves.toEqual({ type: "cancelled" });
		expect(client.session.abort).toHaveBeenCalledWith({ sessionID: "session-1" });
		expect(streamState.returnMock).toHaveBeenCalled();
	});

	test("abort リスナー登録直後に stop されてもイベント待ちでハングしない", async () => {
		const controller = new AbortController();
		const stream = {
			next: mock(() => {
				controller.abort();
				return new Promise<IteratorResult<Event, void>>(() => {});
			}),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;
		const client = createClient(stream);
		const adapter = createAdapter(client as unknown as OpencodeClient);

		await expect(
			adapter.promptAsyncAndWatchSession(
				{
					sessionId: "session-1",
					text: "watch",
					model: { providerId: "provider", modelId: "model" },
				},
				controller.signal,
			),
		).resolves.toEqual({ type: "cancelled" });
		expect(client.session.abort).toHaveBeenCalledTimes(1);
		expect(stream.return).toHaveBeenCalledTimes(1);
	});

	test("通常イベント処理後は abort リスナーを解放し最終 abort でも重複実行しない", async () => {
		const streamState = createStream();
		const client = createClient(streamState.stream);
		const adapter = createAdapter(client as unknown as OpencodeClient);
		const controller = new AbortController();
		const tracked = createTrackedSignal(controller);

		const watch = adapter.promptAsyncAndWatchSession(
			{
				sessionId: "session-1",
				text: "watch",
				model: { providerId: "provider", modelId: "model" },
			},
			tracked.signal,
		);

		streamState.push({
			type: "message.updated",
			properties: {
				info: {
					role: "assistant",
					sessionID: "session-1",
					id: "message-1",
					tokens: { input: 1, output: 2, cache: { read: 3 } },
				},
			},
		} as unknown as Event);
		await Bun.sleep(0);

		expect(tracked.listenerCount()).toBe(1);

		streamState.push({
			type: "message.updated",
			properties: {
				info: {
					role: "assistant",
					sessionID: "session-1",
					id: "message-2",
					tokens: { input: 4, output: 5, cache: { read: 6 } },
				},
			},
		} as unknown as Event);
		await Bun.sleep(0);

		expect(tracked.listenerCount()).toBe(1);

		controller.abort();

		await expect(watch).resolves.toEqual({ type: "cancelled" });
		expect(client.session.abort).toHaveBeenCalledTimes(1);
		expect(streamState.returnMock).toHaveBeenCalledTimes(1);
		expect(tracked.listenerCount()).toBe(0);
	});

	test("購読ストリームの自然終了は idle 扱いで再起動可能にする", async () => {
		const stream = {
			next: mock(() => Promise.resolve({ done: true, value: undefined })),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;
		const client = createClient(stream);
		const adapter = createAdapter(client as unknown as OpencodeClient);

		await expect(
			adapter.promptAsyncAndWatchSession({
				sessionId: "session-1",
				text: "watch",
				model: { providerId: "provider", modelId: "model" },
			}),
		).resolves.toEqual({ type: "idle", tokens: undefined });
	});

	test("abort RPC が reject しても cancelled を返し unhandled rejection にしない", async () => {
		const streamState = createStream();
		const client = createClient(streamState.stream);
		client.session.abort.mockImplementation(() => Promise.reject(new Error("daemon down")));
		const adapter = createAdapter(client as unknown as OpencodeClient);
		const controller = new AbortController();
		const watch = adapter.promptAsyncAndWatchSession(
			{
				sessionId: "session-1",
				text: "watch",
				model: { providerId: "provider", modelId: "model" },
			},
			controller.signal,
		);

		controller.abort();
		await expect(watch).resolves.toEqual({ type: "cancelled" });
		await Bun.sleep(0);
		expect(streamState.returnMock).toHaveBeenCalledTimes(1);
	});

	test("signal なしで stream.next() がハングした場合 streamDisconnected を返す", async () => {
		// STREAM_NEXT_TIMEOUT_MS (5分) を待つのは非現実的なので、
		// withTimeout 経由で streamTimeout → streamDisconnected となることを検証する。
		// nextStreamEvent はタイムアウトを catch して { type: "streamTimeout" } を返し、
		// promptAsyncAndWatchSession はそれを { type: "streamDisconnected" } に変換する。
		const stream = {
			next: mock(
				() =>
					// 即座に reject する withTimeout の挙動をシミュレート
					new Promise<IteratorResult<Event, void>>((_resolve, reject) => {
						setTimeout(() => reject(new Error("stream.next() timed out after 5 minutes")), 10);
					}),
			),
			return: mock(() => Promise.resolve({ done: true, value: undefined })),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;
		const client = createClient(stream);
		const adapter = createAdapter(client as unknown as OpencodeClient);

		await expect(
			adapter.promptAsyncAndWatchSession({
				sessionId: "session-1",
				text: "watch",
				model: { providerId: "provider", modelId: "model" },
			}),
		).resolves.toEqual({ type: "streamDisconnected" });
	});

	test("abort 時に stream.return が reject しても finally 側で同じ reject を回収する", async () => {
		const stream = {
			next: mock(() => new Promise<IteratorResult<Event, void>>(() => {})),
			return: mock(() => Promise.reject(new Error("transport down"))),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as AsyncGenerator<Event, void, unknown>;
		const client = createClient(stream);
		const adapter = createAdapter(client as unknown as OpencodeClient);
		const controller = new AbortController();
		const watch = adapter.promptAsyncAndWatchSession(
			{
				sessionId: "session-1",
				text: "watch",
				model: { providerId: "provider", modelId: "model" },
			},
			controller.signal,
		);

		controller.abort();

		await expect(watch).rejects.toThrow("transport down");
		expect(stream.return).toHaveBeenCalledTimes(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildParts の内部ロジック（ホワイトボックス）
// prompt / promptAsync 経由で buildParts の画像フィルタリングを検証する
// ─────────────────────────────────────────────────────────────────────────────

describe("OpencodeSessionAdapter buildParts（画像フィルタリング）", () => {
	function createBuildPartsAdapter() {
		const promptParts: unknown[] = [];
		const promptAsyncParts: unknown[] = [];
		const client = {
			event: {
				subscribe: mock(() =>
					Promise.resolve({
						stream: {
							// oxlint-disable-next-line no-return-wrap -- AsyncGenerator の next/return は Promise を返す必要がある
							next: mock(() => Promise.resolve({ done: true, value: undefined })),
							// oxlint-disable-next-line no-return-wrap -- AsyncGenerator の next/return は Promise を返す必要がある
							return: mock(() => Promise.resolve({ done: true, value: undefined })),
							[Symbol.asyncIterator]() {
								return this;
							},
						},
					}),
				),
			},
			session: {
				create: mock(() => Promise.resolve({ data: { id: "session-1" }, error: null })),
				get: mock(() => Promise.resolve({ data: null, error: { message: "missing" } })),
				prompt: mock((params: { parts: unknown[] }) => {
					promptParts.push(...params.parts);
					return Promise.resolve({ data: { parts: [], info: {} }, error: null });
				}),
				promptAsync: mock((params: { parts: unknown[] }) => {
					promptAsyncParts.push(...params.parts);
					return Promise.resolve({ data: {}, error: null });
				}),
				abort: mock(() => Promise.resolve({ data: {}, error: null })),
				delete: mock(() => Promise.resolve({ data: {}, error: null })),
			},
		};
		const adapter = new OpencodeSessionAdapter({
			port: 4096,
			mcpServers: {},
			builtinTools: {},
			clientFactory: mock(() =>
				Promise.resolve({
					client: client as unknown as OpencodeClient,
					server: { url: "http://localhost", close: mock(() => {}) },
				}),
			),
		});
		return { adapter, promptParts, promptAsyncParts };
	}

	const baseParams = {
		sessionId: "session-1",
		text: "hello",
		model: { providerId: "provider", modelId: "model" },
	};

	test("image/png の添付は FilePartInput に変換される（prompt 経由）", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [
				{ url: "https://example.com/img.png", contentType: "image/png", filename: "img.png" },
			],
		});

		expect(promptParts).toEqual([
			{ type: "text", text: "hello" },
			{ type: "file", mime: "image/png", filename: "img.png", url: "https://example.com/img.png" },
		]);
	});

	test("image/jpeg, image/gif, image/webp もすべて FilePartInput に変換される", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [
				{ url: "https://example.com/a.jpg", contentType: "image/jpeg", filename: "a.jpg" },
				{ url: "https://example.com/b.gif", contentType: "image/gif", filename: "b.gif" },
				{ url: "https://example.com/c.webp", contentType: "image/webp", filename: "c.webp" },
			],
		});

		expect(promptParts).toEqual([
			{ type: "text", text: "hello" },
			{ type: "file", mime: "image/jpeg", filename: "a.jpg", url: "https://example.com/a.jpg" },
			{ type: "file", mime: "image/gif", filename: "b.gif", url: "https://example.com/b.gif" },
			{ type: "file", mime: "image/webp", filename: "c.webp", url: "https://example.com/c.webp" },
		]);
	});

	test("application/pdf は FilePartInput に変換されない（フィルタアウト）", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [
				{ url: "https://example.com/doc.pdf", contentType: "application/pdf", filename: "doc.pdf" },
			],
		});

		expect(promptParts).toEqual([{ type: "text", text: "hello" }]);
	});

	test("text/plain は FilePartInput に変換されない（フィルタアウト）", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [
				{ url: "https://example.com/note.txt", contentType: "text/plain", filename: "note.txt" },
			],
		});

		expect(promptParts).toEqual([{ type: "text", text: "hello" }]);
	});

	test("contentType が undefined の添付は FilePartInput に変換されない", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [
				{ url: "https://example.com/unknown", contentType: undefined, filename: "unknown" },
			],
		});

		expect(promptParts).toEqual([{ type: "text", text: "hello" }]);
	});

	test("filename が undefined でも image 添付は正しく変換される", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [
				{ url: "https://example.com/img.png", contentType: "image/png", filename: undefined },
			],
		});

		expect(promptParts).toEqual([
			{ type: "text", text: "hello" },
			{
				type: "file",
				mime: "image/png",
				filename: undefined,
				url: "https://example.com/img.png",
			},
		]);
	});

	test("attachments が空配列の場合は text のみの parts", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [],
		});

		expect(promptParts).toEqual([{ type: "text", text: "hello" }]);
	});

	test("attachments が undefined の場合は text のみの parts", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			// attachments フィールドなし
		});

		expect(promptParts).toEqual([{ type: "text", text: "hello" }]);
	});

	test("画像と非画像が混在する場合、画像のみ FilePartInput に変換される", async () => {
		const { adapter, promptParts } = createBuildPartsAdapter();
		await adapter.prompt({
			...baseParams,
			attachments: [
				{ url: "https://example.com/img.png", contentType: "image/png", filename: "img.png" },
				{ url: "https://example.com/doc.pdf", contentType: "application/pdf", filename: "doc.pdf" },
				{ url: "https://example.com/photo.jpg", contentType: "image/jpeg", filename: "photo.jpg" },
			],
		});

		expect(promptParts).toEqual([
			{ type: "text", text: "hello" },
			{ type: "file", mime: "image/png", filename: "img.png", url: "https://example.com/img.png" },
			{
				type: "file",
				mime: "image/jpeg",
				filename: "photo.jpg",
				url: "https://example.com/photo.jpg",
			},
		]);
	});

	test("promptAsync 経由でも buildParts が同じフィルタリングを適用する", async () => {
		const { adapter, promptAsyncParts } = createBuildPartsAdapter();
		await adapter.promptAsync({
			...baseParams,
			attachments: [
				{ url: "https://example.com/img.png", contentType: "image/png", filename: "img.png" },
				{ url: "https://example.com/doc.pdf", contentType: "application/pdf", filename: "doc.pdf" },
			],
		});

		expect(promptAsyncParts).toEqual([
			{ type: "text", text: "hello" },
			{ type: "file", mime: "image/png", filename: "img.png", url: "https://example.com/img.png" },
		]);
	});
});
