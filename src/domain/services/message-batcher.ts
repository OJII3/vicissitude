import type { IncomingMessage, MessageChannel } from "../ports/message-gateway.port.ts";

export interface QueuedMessage {
	msg: IncomingMessage;
	channel: MessageChannel;
}

/**
 * チャンネルごとのメッセージキューを管理する。
 * 純粋 TS、外部依存なし。
 */
export class MessageBatcher {
	private queues = new Map<string, QueuedMessage[]>();

	enqueue(channelId: string, msg: IncomingMessage, channel: MessageChannel): void {
		const queue = this.queues.get(channelId);
		if (queue) {
			queue.push({ msg, channel });
		} else {
			this.queues.set(channelId, [{ msg, channel }]);
		}
	}

	flush(channelId: string): QueuedMessage[] {
		const queue = this.queues.get(channelId) ?? [];
		this.queues.delete(channelId);
		return queue;
	}

	hasPending(channelId: string): boolean {
		const queue = this.queues.get(channelId);
		return queue !== undefined && queue.length > 0;
	}
}
