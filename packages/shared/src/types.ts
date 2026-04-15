// ─── Agent Response ──────────────────────────────────────────────

import type { Emotion } from "./emotion";
import type { MemoryNamespace } from "./namespace";

export interface AgentResponse {
	text: string;
	sessionId: string;
	tokens?: TokenUsage;
	/** 応答時の感情状態（VAD 3 次元）。avatar 連携時に使用 */
	emotion?: Emotion;
}

// ─── Attachment ──────────────────────────────────────────────────

export interface Attachment {
	url: string;
	contentType?: string;
	filename?: string;
}

// ─── Channel Config ──────────────────────────────────────────────

export type ChannelRole = "home" | "default";

export interface ChannelConfig {
	channelId: string;
	guildId: string;
	role: ChannelRole;
	cooldownSeconds: number;
}

// ─── Emoji Usage ─────────────────────────────────────────────────

export interface EmojiUsageCount {
	emojiName: string;
	count: number;
}

// ─── Heartbeat Config ────────────────────────────────────────────

export type ReminderSchedule =
	| { type: "interval"; minutes: number }
	| { type: "daily"; hour: number; minute: number };

export interface HeartbeatReminder {
	id: string;
	description: string;
	schedule: ReminderSchedule;
	lastExecutedAt: string | null;
	enabled: boolean;
	guildId?: string;
}

export interface HeartbeatConfig {
	baseIntervalMinutes: number;
	reminders: HeartbeatReminder[];
}

export interface DueReminder {
	reminder: HeartbeatReminder;
	overdueMinutes: number;
}

// ─── Event Buffer ───────────────────────────────────────────────

export interface EventBuffer {
	append(event: BufferedEvent): void;
	waitForEvents(signal: AbortSignal): Promise<void>;
}

// ─── Buffered Event ──────────────────────────────────────────────

export interface BufferedEvent {
	ts: string;
	content: string;
	authorId: string;
	authorName: string;
	messageId: string;
	attachments?: Attachment[];
	metadata?: Record<string, unknown>;
}

// ─── Incoming Message & Message Channel ──────────────────────────

export interface IncomingMessage {
	platform: string;
	channelId: string;
	channelName?: string;
	guildId?: string;
	authorId: string;
	authorName: string;
	messageId: string;
	content: string;
	attachments: Attachment[];
	timestamp: Date;
	isBot: boolean;
	isMentioned: boolean;
	isThread: boolean;
	reply(text: string): Promise<void>;
	react(emoji: string): Promise<void>;
}

export interface MessageChannel {
	sendTyping(): Promise<void>;
	send(content: string): Promise<void>;
}

// ─── Conversation ────────────────────────────────────────────────

export type ConversationRole = "user" | "assistant" | "system";

export interface ConversationMessage {
	role: ConversationRole;
	content: string;
	name?: string;
	timestamp?: Date;
}

// ─── Memory Fact ─────────────────────────────────────────────────

export interface MemoryFact {
	content: string;
	category: string;
	createdAt: string;
}

// ─── Token Usage ────────────────────────────────────────────────

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
}

// ─── Prompt Result ──────────────────────────────────────────────

export interface PromptResult {
	text: string;
	tokens?: TokenUsage;
}

// ─── Metrics Collector ───────────────────────────────────────────

export interface MetricsCollector {
	incrementCounter(name: string, labels?: Record<string, string>): void;
	addCounter(name: string, value: number, labels?: Record<string, string>): void;
	setGauge(name: string, value: number, labels?: Record<string, string>): void;
	incrementGauge(name: string, labels?: Record<string, string>): void;
	decrementGauge(name: string, labels?: Record<string, string>): void;
	observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
}

// ─── Logger ──────────────────────────────────────────────────────

export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

// ─── Conversation Recorder ───────────────────────────────────────

export interface ConversationRecorder {
	record(namespace: MemoryNamespace, message: ConversationMessage): Promise<void>;
}

// ─── Memory Consolidator ─────────────────────────────────────────

export interface ConsolidationResult {
	processedEpisodes: number;
	newFacts: number;
	reinforced: number;
	updated: number;
	invalidated: number;
}

export interface MemoryConsolidator {
	getActiveNamespaces(): MemoryNamespace[];
	consolidate(namespace: MemoryNamespace): Promise<ConsolidationResult>;
}

// ─── AI Agent ─────────────────────────────────────────────────────

export interface SendOptions {
	sessionKey: string;
	message: string;
	guildId?: string;
	attachments?: Attachment[];
}

export interface AiAgent {
	send(options: SendOptions): Promise<AgentResponse>;
	stop(): void;
}

// ─── Session Store Port ─────────────────────────────────────────

export interface SessionStorePort {
	get(agentName: string, sessionKey: string): string | undefined;
	getRow(
		agentName: string,
		sessionKey: string,
	): { sessionId: string; createdAt: number } | undefined;
	save(agentName: string, sessionKey: string, sessionId: string): void;
	delete(agentName: string, sessionKey: string): void;
}

// ─── Context Builder Port ────────────────────────────────────────

export interface ContextBuilderPort {
	build(guildId?: string): Promise<string>;
}

// ─── Memory Fact Reader ──────────────────────────────────────────

export interface MemoryFactReader {
	getFacts(namespace?: MemoryNamespace): Promise<MemoryFact[]>;
	getRelevantFacts(
		namespace: MemoryNamespace,
		context: string,
		limit: number,
	): Promise<MemoryFact[]>;
	close(): Promise<void>;
}

// ─── OpenCode Session Port ──────────────────────────────────────

export interface OpencodePromptParams {
	sessionId: string;
	text: string;
	model: { providerId: string; modelId: string };
	system?: string;
	tools?: Record<string, boolean>;
}

export type OpencodeSessionEvent =
	| { type: "idle"; tokens?: TokenUsage }
	| { type: "compacted" }
	| { type: "streamDisconnected"; tokens?: TokenUsage }
	| { type: "cancelled" }
	| { type: "error"; message: string };

export interface OpencodeSessionPort {
	createSession(title: string): Promise<string>;
	sessionExists(sessionId: string): Promise<boolean>;
	prompt(params: OpencodePromptParams): Promise<PromptResult>;
	promptAsync(params: OpencodePromptParams): Promise<void>;
	promptAsyncAndWatchSession(
		params: OpencodePromptParams,
		signal?: AbortSignal,
	): Promise<OpencodeSessionEvent>;
	waitForSessionIdle(sessionId: string, signal?: AbortSignal): Promise<OpencodeSessionEvent>;
	deleteSession(sessionId: string): Promise<void>;
	close(): void;
}

// ─── Session Summary Writer ─────────────────────────────────────

export interface SessionSummaryWriter {
	write(guildId: string, content: string): Promise<void>;
}
