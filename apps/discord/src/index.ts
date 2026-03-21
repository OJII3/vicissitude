import { ConsoleLogger } from "@vicissitude/observability/logger";

import { bootstrap } from "./bootstrap.ts";

const logger = new ConsoleLogger();

logger.info("Starting Vicissitude...");

try {
	await bootstrap();
	logger.info("Vicissitude is running.");
} catch (error) {
	logger.error("Failed to start:", error);
	process.exit(1);
}
