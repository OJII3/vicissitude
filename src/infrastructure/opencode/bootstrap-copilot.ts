import { resolve } from "path";

import { BufferEventUseCase } from "../../application/use-cases/buffer-event.use-case.ts";
import type { BootstrapContext } from "../../bootstrap-context.ts";
import { createHeartbeat, setupShutdown, startSessionGauge } from "../../bootstrap-helpers.ts";
import type { IncomingMessage } from "../../domain/ports/message-gateway.port.ts";
import { InstrumentedAiAgent } from "../metrics/instrumented-ai-agent.ts";
import { METRIC } from "../metrics/metric-names.ts";
import { FileEventBuffer } from "../persistence/file-event-buffer.ts";
import { JsonEmojiUsageRepository } from "../persistence/json-emoji-usage-repository.ts";
import { CopilotPollingAgent } from "./copilot-polling-agent.ts";
import { GuildRoutingAgent } from "./guild-routing-agent.ts";

const COPILOT_BASE_PORT = 4096;

function createGuildAgents(ctx: BootstrapContext, guildIds: string[]) {
	const agents = new Map<string, CopilotPollingAgent>();
	const bufferUseCases = new Map<string, BufferEventUseCase>();
	for (const [index, guildId] of guildIds.entries()) {
		const bufferDir = resolve(ctx.root, `data/event-buffer/guilds/${guildId}`);
		const eventBuffer = new FileEventBuffer(bufferDir);
		const port = COPILOT_BASE_PORT + index;
		const agent = new CopilotPollingAgent(
			guildId,
			ctx.sessions,
			ctx.contextLoaderFactory,
			eventBuffer,
			ctx.logger,
			port,
		);
		agents.set(guildId, agent);
		bufferUseCases.set(guildId, new BufferEventUseCase(eventBuffer, ctx.logger));
	}
	return { agents, bufferUseCases };
}

function setupCopilotEventHandlers(
	ctx: BootstrapContext,
	bufferUseCases: Map<string, BufferEventUseCase>,
) {
	const { gateway, logger, metrics } = ctx;
	const routeBuffer = async (msg: IncomingMessage) => {
		const useCase = msg.guildId ? bufferUseCases.get(msg.guildId) : undefined;
		if (useCase) {
			await useCase.execute(msg);
		} else {
			logger.warn(`[bootstrap] No buffer for guildId=${msg.guildId}, dropping event`);
		}
	};
	gateway.onHomeChannelMessage(async (msg) => {
		metrics.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "home" });
		await routeBuffer(msg);
	});
	gateway.onMessage(async (msg) => {
		metrics.incrementCounter(METRIC.DISCORD_MESSAGES_RECEIVED, { channel_type: "mention" });
		await routeBuffer(msg);
	});
}

export async function bootstrapCopilot(ctx: BootstrapContext): Promise<void> {
	const { gateway, channelConfig, logger, metrics, metricsServer, sessions } = ctx;
	const guildIds = channelConfig.getGuildIds();
	const { agents, bufferUseCases } = createGuildAgents(ctx, guildIds);
	setupCopilotEventHandlers(ctx, bufferUseCases);

	const emojiUsageRepo = new JsonEmojiUsageRepository(resolve(ctx.root, "data"));
	gateway.onEmojiUsed((guildId, emojiName) => emojiUsageRepo.increment(guildId, emojiName));

	const firstAgent = agents.values().next().value as CopilotPollingAgent | undefined;
	if (!firstAgent) {
		throw new Error("No guild agents available; cannot create defaultAgent for GuildRoutingAgent");
	}
	const routingAgent = new InstrumentedAiAgent(
		new GuildRoutingAgent(agents, firstAgent),
		metrics,
		"copilot",
	);
	const scheduler = createHeartbeat(ctx.root, routingAgent, logger, metrics);
	const sessionGaugeTimer = startSessionGauge(sessions, metrics);
	setupShutdown(
		logger,
		scheduler,
		gateway,
		routingAgent,
		emojiUsageRepo,
		metricsServer,
		sessionGaugeTimer,
	);

	logger.info(
		`[bootstrap] Copilot polling mode for ${guildIds.length} guild(s): ${guildIds.join(", ")}`,
	);
	await gateway.start();
	scheduler.start();
	for (const [guildId, agent] of agents) {
		agent.startPollingLoop().catch((err) => {
			logger.error(`[bootstrap] polling loop for guild ${guildId} unexpectedly rejected`, err);
		});
	}
}
