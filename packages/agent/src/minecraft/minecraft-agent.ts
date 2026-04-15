import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
import type {
	ContextBuilderPort,
	EventBuffer,
	Logger,
	OpencodeSessionPort,
	SessionStorePort,
} from "@vicissitude/shared/types";

import { mcpMinecraftConfigs } from "../mcp-config.ts";
import { AgentRunner } from "../runner.ts";
import { createMinecraftProfile } from "./profile.ts";

export interface MinecraftAgentDeps {
	sessionStore: SessionStorePort;
	logger: Logger;
	root: string;
	eventBuffer: EventBuffer;
	sessionPort: OpencodeSessionPort;
	contextBuilder: ContextBuilderPort;
	sessionMaxAgeMs: number;
	model: { providerId: string; modelId: string };
	mcHost?: string;
	mcMcpPort?: string;
}

export class MinecraftAgent extends AgentRunner {
	constructor(deps: MinecraftAgentDeps) {
		const profile = createMinecraftProfile({
			...deps.model,
			mcpServers: mcpMinecraftConfigs({
				appRoot: deps.root,
				mcHost: deps.mcHost,
				mcMcpPort: deps.mcMcpPort,
			}),
		});
		super({
			profile,
			agentId: MINECRAFT_AGENT_ID,
			sessionStore: deps.sessionStore,
			contextBuilder: deps.contextBuilder,
			logger: deps.logger,
			sessionPort: deps.sessionPort,
			eventBuffer: deps.eventBuffer,
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
		});
	}
}
