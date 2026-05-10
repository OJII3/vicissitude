import type {
	AppConfig,
	GeniusConfig,
	MinecraftConfig,
	SpotifyConfig,
	TtsConfig,
} from "./config-schema.ts";
import { loadConfigFromProfile, loadProfileConfigFile } from "./profile-config.ts";

export type { AppConfig, GeniusConfig, MinecraftConfig, SpotifyConfig, TtsConfig };

export { loadConfigFromProfile, loadProfileConfigFile };

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
	root?: string,
): AppConfig {
	const path = env.VICISSITUDE_CONFIG_PATH;
	if (!path || !path.trim()) {
		throw new Error("VICISSITUDE_CONFIG_PATH is required");
	}
	return loadConfigFromProfile(loadProfileConfigFile(path), env, root);
}
