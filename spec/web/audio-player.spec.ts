import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ─── Web Audio API Mock ─────────────────────────────────────────
//
// AudioPlayer は Web Audio API (AudioContext, decodeAudioData,
// AudioBufferSourceNode) に依存する。テスト環境では globalThis 上に
// モックを配置して振る舞いを検証する。

type EndedHandler = (() => void) | null;

interface MockAudioBufferSourceNode {
	buffer: unknown;
	connect: ReturnType<typeof mock>;
	start: ReturnType<typeof mock>;
	stop: ReturnType<typeof mock>;
	onended: EndedHandler;
	/** テスト用: onended コールバックを発火させて再生完了をシミュレートする */
	_simulateEnded: () => void;
}

interface MockAudioContext {
	decodeAudioData: ReturnType<typeof mock>;
	createBufferSource: ReturnType<typeof mock>;
	destination: object;
	close: ReturnType<typeof mock>;
	/** テスト用: createBufferSource で生成されたノードの履歴 */
	_sourceNodes: MockAudioBufferSourceNode[];
}

function createMockSourceNode(): MockAudioBufferSourceNode {
	const node: MockAudioBufferSourceNode = {
		buffer: null,
		connect: mock(() => {}),
		start: mock(() => {}),
		stop: mock(() => {}),
		onended: null,
		_simulateEnded() {
			if (node.onended) node.onended();
		},
	};
	return node;
}

function createMockAudioContext(): MockAudioContext {
	const sourceNodes: MockAudioBufferSourceNode[] = [];
	const ctx: MockAudioContext = {
		decodeAudioData: mock((_buffer: ArrayBuffer) =>
			Promise.resolve({ duration: 1.0, length: 44100, sampleRate: 44100 }),
		),
		createBufferSource: mock(() => {
			const node = createMockSourceNode();
			sourceNodes.push(node);
			return node;
		}),
		destination: {},
		close: mock(() => Promise.resolve()),
		_sourceNodes: sourceNodes,
	};
	return ctx;
}

// ─── Global Mocks Setup ─────────────────────────────────────────

let mockCtx: MockAudioContext;
const originalAudioContext = globalThis.AudioContext;

beforeEach(() => {
	mockCtx = createMockAudioContext();
	// @ts-expect-error -- モックを globalThis に注入
	globalThis.AudioContext = mock(() => mockCtx);
});

afterEach(() => {
	if (originalAudioContext) {
		globalThis.AudioContext = originalAudioContext;
	} else {
		// @ts-expect-error -- テスト環境にはもともと存在しない場合
		delete globalThis.AudioContext;
	}
});

// ─── Import (モック設定後に動的インポート) ───────────────────────
//
// AudioPlayer は モジュールトップレベルでは import せず、
// テスト内で動的に import する。これにより beforeEach の
// AudioContext モック設定が確実に適用される。

async function importAudioPlayer() {
	// apps/web は node_modules にリンクされないため相対パスで参照する
	const mod = await import("../../apps/web/src/lib/audio-player");
	return mod.AudioPlayer as new (callbacks?: {
		onPlayStart?: (messageId: string) => void;
		onPlayEnd?: (messageId: string) => void;
	}) => {
		enqueue(messageId: string, audioBase64: string): void;
		readonly playingMessageId: string | null;
		readonly queueLength: number;
		destroy(): void;
	};
}

// ─── Test Fixtures ──────────────────────────────────────────────

// 最小限の有効な base64 エンコード文字列（WAV ヘッダの先頭部分）
const DUMMY_AUDIO_BASE64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEA";
const DUMMY_AUDIO_BASE64_2 = "UklGRjAAAABXQVZFZm10IBAAAAABAAIB";
const DUMMY_AUDIO_BASE64_3 = "UklGRkAAAABXQVZFZm10IBAAAAABAAMA";

// ─── AudioPlayer 仕様テスト ─────────────────────────────────────

describe("AudioPlayer", () => {
	// ─── 初期状態 ─────────────────────────────────────────────────

	describe("初期状態", () => {
		it("生成直後は playingMessageId が null", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			expect(player.playingMessageId).toBeNull();

			player.destroy();
		});

		it("生成直後は queueLength が 0", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			expect(player.queueLength).toBe(0);

			player.destroy();
		});
	});

	// ─── キュー管理 ───────────────────────────────────────────────

	describe("キュー管理", () => {
		it("enqueue すると再生が開始される", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);

			// decodeAudioData は非同期なので待つ
			await flushMicrotasks();

			expect(player.playingMessageId).toBe("msg-001");
			expect(mockCtx._sourceNodes.length).toBeGreaterThanOrEqual(1);
			const firstNode = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			expect(firstNode.connect).toHaveBeenCalled();
			expect(firstNode.start).toHaveBeenCalled();

			player.destroy();
		});

		it("複数 enqueue で FIFO 順に再生される", async () => {
			const AudioPlayer = await importAudioPlayer();
			const playOrder: string[] = [];
			const player = new AudioPlayer({
				onPlayStart: (id) => playOrder.push(id),
			});

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			player.enqueue("msg-002", DUMMY_AUDIO_BASE64_2);
			player.enqueue("msg-003", DUMMY_AUDIO_BASE64_3);

			// 最初の再生を開始させる
			await flushMicrotasks();
			expect(playOrder[0]).toBe("msg-001");

			// 1曲目の再生完了をシミュレート
			const firstNode = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			firstNode._simulateEnded();
			await flushMicrotasks();

			expect(playOrder[1]).toBe("msg-002");

			// 2曲目の再生完了をシミュレート
			const secondNode = mockCtx._sourceNodes[1] as MockAudioBufferSourceNode;
			secondNode._simulateEnded();
			await flushMicrotasks();

			expect(playOrder[2]).toBe("msg-003");

			player.destroy();
		});

		it("再生中に enqueue したアイテムはキューに追加される（即座に再生されない）", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			player.enqueue("msg-002", DUMMY_AUDIO_BASE64_2);
			await flushMicrotasks();

			// 最初のアイテムが再生中
			expect(player.playingMessageId).toBe("msg-001");
			// 2番目はキューで待機
			expect(player.queueLength).toBe(1);

			player.destroy();
		});
	});

	// ─── 再生状態 ─────────────────────────────────────────────────

	describe("再生状態", () => {
		it("再生中は playingMessageId が設定される", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			expect(player.playingMessageId).toBe("msg-001");

			player.destroy();
		});

		it("再生完了後は playingMessageId が null に戻る（キューが空の場合）", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			// 再生完了をシミュレート
			const node = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			node._simulateEnded();
			await flushMicrotasks();

			expect(player.playingMessageId).toBeNull();

			player.destroy();
		});

		it("再生完了後、キューに次のアイテムがあれば次の messageId に切り替わる", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			player.enqueue("msg-002", DUMMY_AUDIO_BASE64_2);
			await flushMicrotasks();

			expect(player.playingMessageId).toBe("msg-001");

			// 1曲目の再生完了
			const firstNode = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			firstNode._simulateEnded();
			await flushMicrotasks();

			expect(player.playingMessageId).toBe("msg-002");

			player.destroy();
		});
	});

	// ─── コールバック ─────────────────────────────────────────────

	describe("コールバック", () => {
		it("再生開始時に onPlayStart が messageId 付きで呼ばれる", async () => {
			const AudioPlayer = await importAudioPlayer();
			const onPlayStart = mock((_id: string) => {});
			const player = new AudioPlayer({ onPlayStart });

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			expect(onPlayStart).toHaveBeenCalledTimes(1);
			expect(onPlayStart).toHaveBeenCalledWith("msg-001");

			player.destroy();
		});

		it("再生完了時に onPlayEnd が messageId 付きで呼ばれる", async () => {
			const AudioPlayer = await importAudioPlayer();
			const onPlayEnd = mock((_id: string) => {});
			const player = new AudioPlayer({ onPlayEnd });

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			const node = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			node._simulateEnded();
			await flushMicrotasks();

			expect(onPlayEnd).toHaveBeenCalledTimes(1);
			expect(onPlayEnd).toHaveBeenCalledWith("msg-001");

			player.destroy();
		});

		it("FIFO キューの各アイテムに対して onPlayStart / onPlayEnd が正しい順序で呼ばれる", async () => {
			const AudioPlayer = await importAudioPlayer();
			const events: string[] = [];
			const player = new AudioPlayer({
				onPlayStart: (id) => events.push(`start:${id}`),
				onPlayEnd: (id) => events.push(`end:${id}`),
			});

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			player.enqueue("msg-002", DUMMY_AUDIO_BASE64_2);
			await flushMicrotasks();

			// msg-001 再生完了
			const firstNode = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			firstNode._simulateEnded();
			await flushMicrotasks();

			// msg-002 再生完了
			const secondNode = mockCtx._sourceNodes[1] as MockAudioBufferSourceNode;
			secondNode._simulateEnded();
			await flushMicrotasks();

			expect(events).toEqual([
				"start:msg-001",
				"end:msg-001",
				"start:msg-002",
				"end:msg-002",
			]);

			player.destroy();
		});

		it("コールバック未設定でもエラーにならない", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			const node = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			expect(() => node._simulateEnded()).not.toThrow();

			player.destroy();
		});
	});

	// ─── queueLength ──────────────────────────────────────────────

	describe("queueLength", () => {
		it("enqueue するたびに queueLength が増加する（再生中のものは含まない）", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();
			// msg-001 は再生中なのでキューには含まれない
			expect(player.queueLength).toBe(0);

			player.enqueue("msg-002", DUMMY_AUDIO_BASE64_2);
			expect(player.queueLength).toBe(1);

			player.enqueue("msg-003", DUMMY_AUDIO_BASE64_3);
			expect(player.queueLength).toBe(2);

			player.destroy();
		});

		it("再生完了でキューからアイテムが消費されると queueLength が減少する", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			player.enqueue("msg-002", DUMMY_AUDIO_BASE64_2);
			player.enqueue("msg-003", DUMMY_AUDIO_BASE64_3);
			await flushMicrotasks();

			expect(player.queueLength).toBe(2);

			// msg-001 再生完了 → msg-002 が再生開始
			const firstNode = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			firstNode._simulateEnded();
			await flushMicrotasks();

			expect(player.queueLength).toBe(1);

			// msg-002 再生完了 → msg-003 が再生開始
			const secondNode = mockCtx._sourceNodes[1] as MockAudioBufferSourceNode;
			secondNode._simulateEnded();
			await flushMicrotasks();

			expect(player.queueLength).toBe(0);

			player.destroy();
		});

		it("全て再生完了後は queueLength が 0", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			const node = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			node._simulateEnded();
			await flushMicrotasks();

			expect(player.queueLength).toBe(0);
			expect(player.playingMessageId).toBeNull();

			player.destroy();
		});
	});

	// ─── destroy ──────────────────────────────────────────────────

	describe("destroy", () => {
		it("destroy 後は playingMessageId が null になる", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();
			expect(player.playingMessageId).toBe("msg-001");

			player.destroy();

			expect(player.playingMessageId).toBeNull();
		});

		it("destroy 後は queueLength が 0 になる", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			player.enqueue("msg-002", DUMMY_AUDIO_BASE64_2);
			await flushMicrotasks();

			player.destroy();

			expect(player.queueLength).toBe(0);
		});

		it("destroy 後の enqueue は無視される（エラーにならない）", async () => {
			const AudioPlayer = await importAudioPlayer();
			const onPlayStart = mock((_id: string) => {});
			const player = new AudioPlayer({ onPlayStart });

			player.destroy();

			expect(() => player.enqueue("msg-001", DUMMY_AUDIO_BASE64)).not.toThrow();
			await flushMicrotasks();

			expect(player.playingMessageId).toBeNull();
			expect(player.queueLength).toBe(0);
			// onPlayStart が呼ばれていないことを確認
			expect(onPlayStart).not.toHaveBeenCalled();
		});

		it("destroy で再生中の音声が停止される", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			const node = mockCtx._sourceNodes[0] as MockAudioBufferSourceNode;
			expect(node.start).toHaveBeenCalled();

			player.destroy();

			expect(node.stop).toHaveBeenCalled();
		});

		it("destroy で AudioContext が閉じられる", async () => {
			const AudioPlayer = await importAudioPlayer();
			const player = new AudioPlayer();

			player.enqueue("msg-001", DUMMY_AUDIO_BASE64);
			await flushMicrotasks();

			player.destroy();

			expect(mockCtx.close).toHaveBeenCalled();
		});
	});
});

// ─── Utility ────────────────────────────────────────────────────

/** マイクロタスクキューをフラッシュする */
function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}
