import { resolve } from "path";

import { OpencodeSessionAdapter } from "@vicissitude/opencode/session-adapter";
import { MINECRAFT_AGENT_ID } from "@vicissitude/shared/constants";
import type { EventBuffer, Logger } from "@vicissitude/shared/types";

import { mcpMinecraftConfigs } from "../mcp-config.ts";
import { AgentRunner } from "../runner.ts";
import type { SessionStore } from "../session-store.ts";
import { MinecraftContextBuilder } from "./context-builder.ts";
import { createMinecraftProfile } from "./profile.ts";

export interface MinecraftAgentDeps {
	sessionStore: SessionStore;
	logger: Logger;
	root: string;
	eventBuffer: EventBuffer;
	/** OpenCode SDK サーバーのポート番号 */
	opencodePort: number;
	sessionMaxAgeMs: number;
	model: { providerId: string; modelId: string };
}

export class MinecraftAgent extends AgentRunner {
	constructor(deps: MinecraftAgentDeps) {
		const profile = createMinecraftProfile({
			...deps.model,
			mcpServers: mcpMinecraftConfigs(),
		});
		super({
			profile,
			agentId: MINECRAFT_AGENT_ID,
			sessionStore: deps.sessionStore,
			contextBuilder: new MinecraftContextBuilder(
				resolve(deps.root, "data/context/minecraft"),
				resolve(deps.root, "context/minecraft"),
			),
			logger: deps.logger,
			sessionPort: new OpencodeSessionAdapter({
				port: deps.opencodePort,
				mcpServers: profile.mcpServers,
				builtinTools: profile.builtinTools,
				logger: deps.logger,
			}),
			eventBuffer: deps.eventBuffer,
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
		});
	}
}
