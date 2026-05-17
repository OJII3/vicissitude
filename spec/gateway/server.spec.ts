import { describe, expect, it } from "bun:test";

import {
	createGatewayApp,
	listenGatewayServer,
	type GatewayApp,
	type GatewayServer,
} from "@vicissitude/gateway/server";
import type { ClientMessageHandler } from "@vicissitude/shared/ports";
import type { ServerMessage } from "@vicissitude/shared/ws-protocol";

function createManager(connectionCount: number) {
	return {
		handleOpen() {},
		handleMessage() {},
		handleClose() {},
		send() {},
		broadcast(_message: ServerMessage) {},
		onMessage(_handler: ClientMessageHandler) {},
		getConnectionCount: () => connectionCount,
	};
}

describe("Gateway server", () => {
	it("createGatewayApp は listen せずに /health を扱える app を生成する", async () => {
		const app = createGatewayApp(createManager(3));

		const response = await app.handle(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			connections: 3,
		});
	});

	it("listenGatewayServer は渡された app に listen 副作用を閉じ込める", () => {
		const server: GatewayServer = {
			stop: () => Promise.resolve(),
		};
		let listenedPort: number | undefined;
		const app: GatewayApp = {
			handle: () => new Response(null),
			listen(port) {
				listenedPort = port;
				return server;
			},
		};

		const result = listenGatewayServer(app, 38080);

		expect(result).toBe(server);
		expect(listenedPort).toBe(38080);
	});
});
