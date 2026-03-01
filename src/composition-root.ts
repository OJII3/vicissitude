import { resolve } from "path";

import { HandleIncomingMessageUseCase } from "./application/use-cases/handle-incoming-message.use-case.ts";
import { FileContextLoader } from "./infrastructure/context/file-context-loader.ts";
import { DiscordGateway } from "./infrastructure/discord/discord-gateway.ts";
import { ConsoleLogger } from "./infrastructure/logging/console-logger.ts";
import { OpencodeAgent } from "./infrastructure/opencode/opencode-agent.ts";
import { JsonSessionRepository } from "./infrastructure/persistence/json-session-repository.ts";

export async function bootstrap(): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	if (!token) throw new Error("DISCORD_TOKEN is required in .env");

	const root = resolve(import.meta.dirname, "..");

	// Infrastructure
	const logger = new ConsoleLogger();
	const sessions = new JsonSessionRepository(resolve(root, "data"));
	const contextLoader = new FileContextLoader(resolve(root, "context"));
	const agent = new OpencodeAgent(sessions, contextLoader);
	const gateway = new DiscordGateway(token, logger);

	// Use cases
	const handleMessage = new HandleIncomingMessageUseCase(agent, logger);

	// Wiring
	gateway.onMessage((msg, ch) => handleMessage.execute(msg, ch));

	// Graceful shutdown
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("Shutting down...");
		gateway.stop();
		agent.stop();
		// イベントループを回して進行中の非同期処理を完了させる
		setTimeout(() => process.exit(0), 1000);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await gateway.start();
}
