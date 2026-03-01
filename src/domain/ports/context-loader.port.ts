export interface ContextLoader {
	loadBootstrapContext(): Promise<string>;
	wrapWithContext(message: string): Promise<string>;
}

export interface ContextLoaderFactory {
	create(guildId?: string): ContextLoader;
}
