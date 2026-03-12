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
