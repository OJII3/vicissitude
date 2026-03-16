import type { ServerMessage, ClientMessage } from "@vicissitude/shared/ws-protocol";
import { parseServerMessage } from "@vicissitude/shared/ws-protocol";

export type ServerMessageListener = (message: ServerMessage) => void;

export class WsClient {
	private ws: WebSocket | null = null;
	private listeners: Set<ServerMessageListener> = new Set();
	private url: string;

	constructor(url: string) {
		this.url = url;
	}

	connect(): void {
		this.ws = new WebSocket(this.url);
		this.ws.addEventListener("message", (event) => {
			const message = parseServerMessage(String(event.data));
			for (const listener of this.listeners) {
				listener(message);
			}
		});
	}

	send(message: ClientMessage): void {
		this.ws?.send(JSON.stringify(message));
	}

	onMessage(listener: ServerMessageListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	disconnect(): void {
		this.ws?.close();
		this.ws = null;
	}
}
