export interface ContextLoader {
	loadBootstrapContext(): Promise<string>;
	wrapWithContext(message: string): Promise<string>;
}
