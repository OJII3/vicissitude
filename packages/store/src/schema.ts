import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** セッション管理テーブル */
export const sessions = sqliteTable("sessions", {
	key: text("key").primaryKey(),
	sessionId: text("session_id").notNull(),
	createdAt: integer("created_at").notNull(),
});

/** 絵文字使用カウントテーブル */
export const emojiUsage = sqliteTable(
	"emoji_usage",
	{
		guildId: text("guild_id").notNull(),
		emojiName: text("emoji_name").notNull(),
		count: integer("count").notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.guildId, table.emojiName] })],
);

/** イベントバッファテーブル */
export const eventBuffer = sqliteTable("event_buffer", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	agentId: text("agent_id").notNull(),
	payload: text("payload").notNull(),
	createdAt: integer("created_at").notNull(),
});

/** 感情状態テーブル */
export const moodState = sqliteTable("mood_state", {
	agentId: text("agent_id").primaryKey(),
	valence: real("valence").notNull(),
	arousal: real("arousal").notNull(),
	dominance: real("dominance").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/** エージェントハートビートテーブル（MCP wait_for_events の生存シグナル） */
export const agentHeartbeat = sqliteTable("agent_heartbeat", {
	agentId: text("agent_id").primaryKey(),
	lastSeenAt: integer("last_seen_at").notNull(),
	/** MCP 側からセッションローテーションを要求するフラグ（タイムスタンプ、0 = 要求なし） */
	rotationRequestedAt: integer("rotation_requested_at").notNull().default(0),
});

/** MC セッション排他ロックテーブル（最大1行） */
export const mcSessionLock = sqliteTable("mc_session_lock", {
	id: integer("id").primaryKey(),
	guildId: text("guild_id").notNull(),
	acquiredAt: integer("acquired_at").notNull(),
	connected: integer("connected").notNull().default(0),
	connectedAt: integer("connected_at"),
});
