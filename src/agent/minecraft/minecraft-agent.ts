import { resolve } from "path";

import { MC_BRAIN_GUILD_ID, MC_BRAIN_WAKE_SIGNAL_RELATIVE_PATH } from "../../core/constants.ts";
import type { Logger } from "../../core/types.ts";
import { OpencodeSessionAdapter } from "../../opencode/session-adapter.ts";
import { MinecraftEventBuffer } from "../../store/minecraft-event-buffer.ts";
import { mcpMinecraftConfigs } from "../mcp-config.ts";
import { AgentRunner } from "../runner.ts";
import type { SessionStore } from "../session-store.ts";
import { MinecraftContextBuilder } from "./context-builder.ts";
import { createMinecraftProfile } from "./profile.ts";

export interface MinecraftAgentDeps {
	sessionStore: SessionStore;
	logger: Logger;
	root: string;
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
			guildId: MC_BRAIN_GUILD_ID,
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
			}),
			eventBuffer: new MinecraftEventBuffer(
				30_000,
				resolve(deps.root, MC_BRAIN_WAKE_SIGNAL_RELATIVE_PATH),
			),
			sessionMaxAgeMs: deps.sessionMaxAgeMs,
		});
	}
}
