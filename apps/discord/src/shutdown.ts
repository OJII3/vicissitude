import type { Logger } from "@vicissitude/shared/types";

export interface ShutdownDeps {
	logger: Logger;
	sessionGaugeTimer: ReturnType<typeof setInterval>;
	consolidationScheduler?: { stop(): void };
	heartbeatScheduler: { stop(): void };
	gateway: { stop(): void };
	gatewayServer: { stop(): Promise<unknown> };
	mcBrainManager?: { stop(): void };
	heartbeatRouter: { stop(): void };
	routingAgent: { stop(): void };
	metricsServer: { stop(): void };
	factReader: { close(): void };
	chatAdapter?: { close(): void };
	recorder?: { close(): void };
	mcProcess?: { kill(): void } | null;
	closeDb: () => void;
}

export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
	let shuttingDown = false;

	return async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		deps.logger.info("[bootstrap] Shutting down...");
		// Force exit after 5 seconds if graceful shutdown hangs
		const forceTimer = setTimeout(() => process.exit(1), 5000);

		const safe = async (label: string, fn: () => void | Promise<void>) => {
			try {
				await fn();
			} catch (err) {
				deps.logger.error(`[bootstrap] ${label}:`, err);
			}
		};

		await safe("sessionGauge", () => clearInterval(deps.sessionGaugeTimer));
		await safe("consolidation", () => deps.consolidationScheduler?.stop());
		await safe("heartbeatScheduler", () => deps.heartbeatScheduler.stop());
		await safe("gateway", () => deps.gateway.stop());
		await safe("gatewayServer", async () => void (await deps.gatewayServer.stop()));
		await safe("mcBrainManager", () => deps.mcBrainManager?.stop());
		// heartbeatRouter.stop() -> each AgentRunner.stop() -> sessionPort.close() (SIGTERM to opencode child)
		await safe("heartbeatRouter", () => deps.heartbeatRouter.stop());
		// routingAgent.stop() -> GuildRouter.stop() -> each AgentRunner.stop() -> sessionPort.close()
		await safe("routingAgent", () => deps.routingAgent.stop());
		await safe("metrics", () => deps.metricsServer.stop());
		await safe("factReader", () => deps.factReader.close());
		// chatAdapter.close() -> MemoryChatAdapter.close() -> memorySessionPort.close()
		await safe("chatAdapter", () => deps.chatAdapter?.close());
		await safe("recorder", () => deps.recorder?.close());
		await safe("mcProcess", () => deps.mcProcess?.kill());
		await safe("db", () => deps.closeDb());

		clearTimeout(forceTimer);
		process.exit(0);
	};
}
