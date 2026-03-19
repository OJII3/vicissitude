import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@vicissitude/shared/types";

import type { JobManager } from "../job-manager.ts";
import { registerAttackEntity } from "./combat.ts";
import { registerSendChat, registerEquipItem, registerPlaceBlock } from "./interaction.ts";
import { registerCraftItem, registerSleepInBed, registerSmeltItem } from "./jobs.ts";
import {
	registerFollowPlayer,
	registerGoTo,
	registerCollectBlock,
	registerStop,
} from "./movement.ts";
import type { GetBot } from "./shared.ts";
import { registerSurvivalTools } from "./survival/index.ts";

export function registerActionTools(
	server: McpServer,
	getBot: GetBot,
	jobManager: JobManager,
	logger: Logger,
): void {
	registerFollowPlayer(server, getBot, jobManager);
	registerGoTo(server, getBot, jobManager);
	registerCollectBlock(server, getBot, jobManager);
	registerStop(server, jobManager);
	registerSendChat(server, getBot);
	registerEquipItem(server, getBot);
	registerPlaceBlock(server, getBot);
	registerCraftItem(server, getBot, jobManager);
	registerSmeltItem(server, getBot, jobManager);
	registerSleepInBed(server, getBot, jobManager, logger);
	registerSurvivalTools(server, getBot, jobManager);
	registerAttackEntity(server, getBot, jobManager);
}
