import type { ConnectionId } from "@vicissitude/shared/ports";
import { Elysia } from "elysia";

import type { WebSocketConnection } from "./ws-handler";

export interface GatewayConnectionManager {
	handleOpen(connectionId: ConnectionId, connection: WebSocketConnection): void;
	handleMessage(connectionId: ConnectionId, rawMessage: string): void;
	handleClose(connectionId: ConnectionId): void;
	getConnectionCount(): number;
}

export interface GatewayServer {
	stop(): Promise<unknown>;
}

export interface GatewayApp {
	handle(request: Request): Response | Promise<Response>;
	listen(port: number): GatewayServer;
}

export function createGatewayApp(manager: GatewayConnectionManager): GatewayApp {
	return new Elysia()
		.get("/health", () => ({
			status: "ok",
			connections: manager.getConnectionCount(),
		}))
		.ws("/ws", {
			open(ws) {
				manager.handleOpen(ws.id, { send: (data) => ws.send(data) });
			},
			message(ws, message) {
				manager.handleMessage(
					ws.id,
					typeof message === "string" ? message : JSON.stringify(message),
				);
			},
			close(ws) {
				manager.handleClose(ws.id);
			},
		});
}

export function listenGatewayServer(app: GatewayApp, port: number): GatewayServer {
	return app.listen(port);
}
