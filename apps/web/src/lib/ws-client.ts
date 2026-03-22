import type { ServerMessage, ClientMessage } from "@vicissitude/shared/ws-protocol";
import { parseServerMessage } from "@vicissitude/shared/ws-protocol";

export type ServerMessageListener = (message: ServerMessage) => void;

export class WsClient {
	private ws: WebSocket | null = null;
	private listeners: Set<ServerMessageListener> = new Set();
	private openListeners: Set<() => void> = new Set();
	private closeListeners: Set<() => void> = new Set();
	private url: string;

	constructor(url: string) {
		this.url = url;
	}

	connect(): void {
		this.ws = new WebSocket(this.url);
		this.ws.addEventListener("open", () => {
			for (const listener of this.openListeners) listener();
		});
		this.ws.addEventListener("close", () => {
			for (const listener of this.closeListeners) listener();
		});
		this.ws.addEventListener("message", (event) => {
			try {
				const message = parseServerMessage(String(event.data));
				for (const listener of this.listeners) {
					listener(message);
				}
			} catch (error) {
				console.warn("[ws] Failed to parse server message", error);
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

	onOpen(listener: () => void): () => void {
		this.openListeners.add(listener);
		return () => this.openListeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	disconnect(): void {
		this.ws?.close();
		this.ws = null;
	}
}
