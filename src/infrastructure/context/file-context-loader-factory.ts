import type {
	ContextLoader,
	ContextLoaderFactory,
} from "../../domain/ports/context-loader.port.ts";
import { FileContextLoader } from "./file-context-loader.ts";

const GUILD_ID_REGEX = /^\d+$/;

export class FileContextLoaderFactory implements ContextLoaderFactory {
	constructor(
		private readonly overlayDir: string,
		private readonly baseDir: string,
	) {}

	create(guildId?: string): ContextLoader {
		if (guildId !== undefined && !GUILD_ID_REGEX.test(guildId)) {
			throw new Error(`Invalid guildId: ${guildId}`);
		}
		return new FileContextLoader(this.overlayDir, this.baseDir, guildId);
	}
}
