import type { ClientMessageHandler, ConnectionId, GatewayPort } from "@vicissitude/shared/ports";
import type { ErrorMessage, ServerMessage } from "@vicissitude/shared/ws-protocol";
import { parseClientMessage } from "@vicissitude/shared/ws-protocol";

export interface WebSocketConnection {
	send(data: string): void;
}

export class WsConnectionManager implements GatewayPort {
	private readonly connections = new Map<ConnectionId, WebSocketConnection>();
	private readonly handlers: ClientMessageHandler[] = [];

	handleOpen(connectionId: string, connection: WebSocketConnection): void {
		this.connections.set(connectionId, connection);
	}

	handleClose(connectionId: string): void {
		this.connections.delete(connectionId);
	}

	handleMessage(connectionId: string, rawMessage: string): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		try {
			const message = parseClientMessage(rawMessage);
			for (const handler of this.handlers) {
				handler(connectionId, message);
			}
		} catch {
			const errorMsg: ErrorMessage = {
				type: "error",
				code: "INVALID_MESSAGE",
				message: "Failed to parse client message",
				timestamp: new Date().toISOString(),
			};
			connection.send(JSON.stringify(errorMsg));
		}
	}

	send(connectionId: ConnectionId, message: ServerMessage): void {
		const connection = this.connections.get(connectionId);
		if (!connection) return;
		connection.send(JSON.stringify(message));
	}

	broadcast(message: ServerMessage): void {
		const data = JSON.stringify(message);
		for (const connection of this.connections.values()) {
			connection.send(data);
		}
	}

	onMessage(handler: ClientMessageHandler): void {
		this.handlers.push(handler);
	}

	getConnectionCount(): number {
		return this.connections.size;
	}
}
