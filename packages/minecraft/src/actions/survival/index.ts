import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { JobManager } from "../../job-manager.ts";
import type { GetBot } from "../shared.ts";
import { registerFleeFromEntity } from "./escape.ts";
import { registerEatFood } from "./food.ts";
import { registerFindShelter } from "./shelter.ts";

export { listEdibleFoods } from "./food.ts";

export function registerSurvivalTools(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
): void {
	registerEatFood(server, getBot);
	registerFleeFromEntity(server, getBot, jobManager);
	registerFindShelter(server, getBot, jobManager);
}
