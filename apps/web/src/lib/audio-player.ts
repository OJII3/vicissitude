export type AudioPlayerCallbacks = {
	onPlayStart?: (messageId: string) => void;
	onPlayEnd?: (messageId: string) => void;
};

interface QueueItem {
	messageId: string;
	audioBase64: string;
}

export class AudioPlayer {
	private ctx: AudioContext;
	private queue: QueueItem[] = [];
	private currentMessageId: string | null = null;
	private currentSource: AudioBufferSourceNode | null = null;
	private isPlaying = false;
	private destroyed = false;
	private callbacks: AudioPlayerCallbacks;

	constructor(callbacks?: AudioPlayerCallbacks) {
		this.ctx = new AudioContext();
		this.callbacks = callbacks ?? {};
	}

	enqueue(messageId: string, audioBase64: string): void {
		if (this.destroyed) return;

		if (this.isPlaying) {
			this.queue.push({ messageId, audioBase64 });
			return;
		}

		this.playItem({ messageId, audioBase64 });
	}

	get playingMessageId(): string | null {
		return this.currentMessageId;
	}

	get queueLength(): number {
		return this.queue.length;
	}

	destroy(): void {
		this.destroyed = true;
		this.queue = [];

		if (this.currentSource) {
			try {
				this.currentSource.stop();
			} catch {
				// already stopped
			}
			this.currentSource = null;
		}

		this.currentMessageId = null;
		this.isPlaying = false;
		this.ctx.close();
	}

	private async playItem(item: QueueItem): Promise<void> {
		this.isPlaying = true;
		this.currentMessageId = item.messageId;

		if (this.ctx.state === "suspended") {
			await this.ctx.resume();
		}

		const binaryString = atob(item.audioBase64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.codePointAt(i) ?? 0;
		}

		let audioBuffer: AudioBuffer;
		try {
			audioBuffer = await this.ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
		} catch {
			this.advanceQueue();
			return;
		}
		if (this.destroyed) return;

		const source = this.ctx.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(this.ctx.destination);

		this.currentSource = source as AudioBufferSourceNode;

		this.callbacks.onPlayStart?.(item.messageId);

		source.addEventListener("ended", () => {
			if (this.destroyed) return;

			this.callbacks.onPlayEnd?.(item.messageId);
			this.currentSource = null;
			this.advanceQueue();
		});

		source.start();
	}

	private advanceQueue(): void {
		const next = this.queue.shift();
		if (next) {
			void this.playItem(next);
		} else {
			this.isPlaying = false;
			this.currentMessageId = null;
		}
	}
}
