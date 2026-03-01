import type {
	ContextLoader,
	ContextLoaderFactory,
} from "../../domain/ports/context-loader.port.ts";
import { FileContextLoader } from "./file-context-loader.ts";

export class FileContextLoaderFactory implements ContextLoaderFactory {
	constructor(private readonly contextDir: string) {}

	create(guildId?: string): ContextLoader {
		return new FileContextLoader(this.contextDir, guildId);
	}
}
