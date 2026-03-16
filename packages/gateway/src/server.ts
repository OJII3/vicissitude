import { Elysia } from "elysia";

import type { WsConnectionManager } from "./ws-handler";

export function createGatewayServer(port: number, manager: WsConnectionManager) {
	const wsToId = new WeakMap<object, string>();

	return new Elysia()
		.get("/health", () => ({
			status: "ok",
			connections: manager.getConnectionCount(),
		}))
		.ws("/ws", {
			open(ws) {
				const connectionId = crypto.randomUUID();
				wsToId.set(ws, connectionId);
				manager.handleOpen(connectionId, { send: (data) => ws.send(data) });
			},
			message(ws, message) {
				const connectionId = wsToId.get(ws);
				if (connectionId) {
					manager.handleMessage(
						connectionId,
						typeof message === "string" ? message : JSON.stringify(message),
					);
				}
			},
			close(ws) {
				const connectionId = wsToId.get(ws);
				if (connectionId) {
					manager.handleClose(connectionId);
				}
			},
		})
		.listen(port);
}
