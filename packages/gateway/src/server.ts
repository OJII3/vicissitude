import { Elysia } from "elysia";

import type { WsConnectionManager } from "./ws-handler";

export function createGatewayServer(port: number, manager: WsConnectionManager) {
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
		})
		.listen(port);
}
