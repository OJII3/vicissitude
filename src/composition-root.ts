import { existsSync } from "fs";
import { resolve } from "path";

import type { BootstrapContext } from "./bootstrap-context.ts";
import type { Logger } from "./domain/ports/logger.port.ts";
import { FileContextLoaderFactory } from "./infrastructure/context/file-context-loader-factory.ts";
import { JsonChannelConfigLoader } from "./infrastructure/context/json-channel-config-loader.ts";
import { DiscordGateway } from "./infrastructure/discord/discord-gateway.ts";
import { ConsoleLogger } from "./infrastructure/logging/console-logger.ts";
import { METRIC } from "./infrastructure/metrics/metric-names.ts";
import { PrometheusCollector } from "./infrastructure/metrics/prometheus-collector.ts";
import { PrometheusServer } from "./infrastructure/metrics/prometheus-server.ts";
import { bootstrapCopilot } from "./infrastructure/opencode/bootstrap-copilot.ts";
import { JsonSessionRepository } from "./infrastructure/persistence/json-session-repository.ts";

async function loadChannelConfig(root: string) {
	const overlayChannels = resolve(root, "data/context/channels.json");
	const baseChannels = resolve(root, "context/channels.json");
	const channelsJson = existsSync(overlayChannels)
		? await Bun.file(overlayChannels).json()
		: await Bun.file(baseChannels).json();
	return new JsonChannelConfigLoader(channelsJson);
}

function createMetrics(logger: Logger) {
	const collector = new PrometheusCollector();
	collector.registerCounter(METRIC.DISCORD_MESSAGES_RECEIVED, "Discord messages received");
	collector.registerCounter(METRIC.AI_REQUESTS, "AI agent requests");
	collector.registerCounter(METRIC.HEARTBEAT_TICKS, "Heartbeat scheduler ticks");
	collector.registerCounter(METRIC.HEARTBEAT_REMINDERS_EXECUTED, "Heartbeat reminders executed");
	collector.registerGauge(METRIC.BOT_INFO, "Bot information");
	collector.registerHistogram(METRIC.AI_REQUEST_DURATION, "AI request duration in seconds");
	collector.registerHistogram(METRIC.HEARTBEAT_TICK_DURATION, "Heartbeat tick duration in seconds");
	collector.registerGauge(METRIC.LLM_ACTIVE_SESSIONS, "Registered LLM sessions");
	collector.registerGauge(METRIC.LLM_BUSY_SESSIONS, "LLM sessions currently processing");
	collector.setGauge(METRIC.BOT_INFO, 1, { bot_name: "fua" });
	return { collector, server: new PrometheusServer(collector, logger) };
}

export async function bootstrap(): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	if (!token) throw new Error("DISCORD_TOKEN is required in .env");

	const root = resolve(import.meta.dirname, "..");
	const logger = new ConsoleLogger();
	const sessions = new JsonSessionRepository(resolve(root, "data"));
	const contextLoaderFactory = new FileContextLoaderFactory(
		resolve(root, "data/context"),
		resolve(root, "context"),
	);
	const gateway = new DiscordGateway(token, logger);
	const { collector: metrics, server: metricsServer } = createMetrics(logger);
	metricsServer.start();

	const channelConfig = await loadChannelConfig(root);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	const ctx: BootstrapContext = {
		root,
		sessions,
		contextLoaderFactory,
		gateway,
		channelConfig,
		logger,
		metrics,
		metricsServer,
	};
	await bootstrapCopilot(ctx);
}
