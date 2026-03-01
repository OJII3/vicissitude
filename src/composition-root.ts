import { resolve } from "path";

import { HandleHomeChannelMessageUseCase } from "./application/use-cases/handle-home-channel-message.use-case.ts";
import { HandleIncomingMessageUseCase } from "./application/use-cases/handle-incoming-message.use-case.ts";
import { CooldownTracker } from "./domain/services/cooldown-tracker.ts";
import { FileContextLoader } from "./infrastructure/context/file-context-loader.ts";
import { JsonChannelConfigLoader } from "./infrastructure/context/json-channel-config-loader.ts";
import { DiscordConversationHistory } from "./infrastructure/discord/discord-conversation-history.ts";
import { DiscordGateway } from "./infrastructure/discord/discord-gateway.ts";
import { ConsoleLogger } from "./infrastructure/logging/console-logger.ts";
import { OpencodeAgent } from "./infrastructure/opencode/opencode-agent.ts";
import { OpencodeJudgeAgent } from "./infrastructure/opencode/opencode-judge-agent.ts";
import { OpencodeResponseJudge } from "./infrastructure/opencode/opencode-response-judge.ts";
import { JsonSessionRepository } from "./infrastructure/persistence/json-session-repository.ts";

function createInfrastructure(root: string, token: string) {
	const logger = new ConsoleLogger();
	const sessions = new JsonSessionRepository(resolve(root, "data"));
	const contextLoader = new FileContextLoader(resolve(root, "context"));
	const agent = new OpencodeAgent(sessions, contextLoader);
	const judgeAgent = new OpencodeJudgeAgent();
	const gateway = new DiscordGateway(token, logger);
	return { logger, agent, judgeAgent, gateway };
}

export async function bootstrap(): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	if (!token) throw new Error("DISCORD_TOKEN is required in .env");

	const root = resolve(import.meta.dirname, "..");
	const { logger, agent, judgeAgent, gateway } = createInfrastructure(root, token);

	// Channel config
	const channelsJson = await Bun.file(resolve(root, "context/channels.json")).json();
	const channelConfig = new JsonChannelConfigLoader(channelsJson);
	gateway.setHomeChannelIds(channelConfig.getHomeChannelIds());

	// Home channel infrastructure
	const conversationHistory = new DiscordConversationHistory(() => gateway.getClient());
	const responseJudge = new OpencodeResponseJudge(judgeAgent, logger);
	const cooldown = new CooldownTracker();

	// Use cases
	const handleMessage = new HandleIncomingMessageUseCase(agent, logger);
	const handleHomeMessage = new HandleHomeChannelMessageUseCase(
		agent,
		responseJudge,
		conversationHistory,
		channelConfig,
		cooldown,
		logger,
	);

	// Wiring
	gateway.onMessage((msg, ch) => handleMessage.execute(msg, ch));
	gateway.onHomeChannelMessage((msg, ch) => handleHomeMessage.execute(msg, ch));

	// Graceful shutdown
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down...");
		gateway.stop();
		agent.stop();
		judgeAgent.stop();
		setTimeout(() => process.exit(0), 1000);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await gateway.start();
}
