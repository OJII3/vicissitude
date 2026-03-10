import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
	guildId: text("guild_id").notNull(),
	payload: text("payload").notNull(),
	createdAt: integer("created_at").notNull(),
});

/** MC セッション排他ロックテーブル（最大1行） */
export const mcSessionLock = sqliteTable("mc_session_lock", {
	id: integer("id").primaryKey(),
	guildId: text("guild_id").notNull(),
	acquiredAt: integer("acquired_at").notNull(),
});

/** MC ブリッジイベントテーブル */
export const mcBridgeEvents = sqliteTable("mc_bridge_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	/** 'to_discord' | 'to_minecraft' */
	direction: text("direction").notNull(),
	type: text("type").notNull(),
	payload: text("payload").notNull(),
	createdAt: integer("created_at").notNull(),
	consumed: integer("consumed").notNull().default(0),
});
