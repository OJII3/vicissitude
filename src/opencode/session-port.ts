export interface OpencodePromptParams {
	sessionId: string;
	text: string;
	model: { providerId: string; modelId: string };
	system?: string;
	tools?: Record<string, boolean>;
}

export type OpencodeSessionEvent =
	| { type: "idle" }
	| { type: "compacted" }
	| { type: "error"; message: string };

export interface OpencodeSessionPort {
	createSession(title: string): Promise<string>;
	sessionExists(sessionId: string): Promise<boolean>;
	prompt(params: OpencodePromptParams): Promise<string>;
	promptAsync(params: OpencodePromptParams): Promise<void>;
	waitForSessionIdle(sessionId: string, signal?: AbortSignal): Promise<OpencodeSessionEvent>;
	deleteSession(sessionId: string): Promise<void>;
	close(): void;
}
