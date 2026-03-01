export interface ContextLoader {
	loadBootstrapContext(): Promise<string>;
}

export interface ContextLoaderFactory {
	create(guildId?: string): ContextLoader;
}
