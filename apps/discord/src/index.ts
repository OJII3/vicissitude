import { ConsoleLogger } from "@vicissitude/observability/logger";

import { bootstrap } from "./bootstrap.ts";

const logger = new ConsoleLogger();

logger.info("[app] Starting Vicissitude...");

try {
	await bootstrap();
	logger.info("[app] Vicissitude is running.");
} catch (error) {
	logger.error("[app] Failed to start:", error);
	process.exit(1);
}
