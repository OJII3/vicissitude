// ─── Branded Types ───────────────────────────────────────────────

export type GuildId = string & { readonly __brand: "GuildId" };
export type ChannelId = string & { readonly __brand: "ChannelId" };
export type SessionKey = string & { readonly __brand: "SessionKey" };

export function guildId(raw: string): GuildId {
	if (!raw) throw new Error("GuildId must be a non-empty string");
	return raw as GuildId;
}

export function channelId(raw: string): ChannelId {
	if (!raw) throw new Error("ChannelId must be a non-empty string");
	return raw as ChannelId;
}

export function createSessionKey(platform: string, chId: string, userId: string): SessionKey {
	if (!platform || !chId || !userId) {
		throw new Error("createSessionKey: platform, chId, userId must be non-empty strings");
	}
	return `${platform}:${chId}:${userId}` as SessionKey;
}

export function createChannelSessionKey(platform: string, chId: string): SessionKey {
	if (!platform || !chId) {
		throw new Error("createChannelSessionKey: platform, chId must be non-empty strings");
	}
	return `${platform}:${chId}:_channel` as SessionKey;
}

// ─── Agent Response ──────────────────────────────────────────────

export interface AgentResponse {
	text: string;
	sessionId: string;
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

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
	baseIntervalMinutes: 1,
	reminders: [
		{
			id: "home-check",
			description: "ホームチャンネルの様子を見る",
			schedule: { type: "interval", minutes: 1440 },
			lastExecutedAt: null,
			enabled: true,
		},
		{
			id: "memory-update",
			description:
				"memory MCP ツールを使ってメモリを更新する。手順: daily log → MEMORY.md → LESSONS.md → SOUL.md の順で確認・更新",
			schedule: { type: "interval", minutes: 360 },
			lastExecutedAt: null,
			enabled: true,
		},
	],
};

// ─── Buffered Event ──────────────────────────────────────────────

export interface BufferedEvent {
	ts: string;
	channelId: string;
	guildId?: string;
	authorId: string;
	authorName: string;
	messageId: string;
	content: string;
	attachments?: Attachment[];
	isBot: boolean;
	isMentioned: boolean;
	isThread: boolean;
}

// ─── Incoming Message & Message Channel ──────────────────────────

export interface IncomingMessage {
	platform: string;
	channelId: string;
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

// ─── LTM Fact ────────────────────────────────────────────────────

export interface LtmFact {
	content: string;
	category: string;
	createdAt: string;
}

// ─── Metrics Collector ───────────────────────────────────────────

export interface MetricsCollector {
	incrementCounter(name: string, labels?: Record<string, string>): void;
	setGauge(name: string, value: number, labels?: Record<string, string>): void;
	incrementGauge(name: string, labels?: Record<string, string>): void;
	decrementGauge(name: string, labels?: Record<string, string>): void;
	observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
}

// ─── Logger ──────────────────────────────────────────────────────

export interface Logger {
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

// ─── Conversation Recorder ───────────────────────────────────────

export interface ConversationRecorder {
	record(guildId: string, message: ConversationMessage): Promise<void>;
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
	getActiveGuildIds(): string[];
	consolidate(guildId: string): Promise<ConsolidationResult>;
}

// ─── LTM Fact Reader ─────────────────────────────────────────────

export interface LtmFactReader {
	getFacts(guildId?: string): Promise<LtmFact[]>;
	close(): Promise<void>;
}
