import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** セッション管理テーブル */
export const sessions = sqliteTable("sessions", {
	key: text("key").primaryKey(),
	sessionId: text("session_id").notNull(),
	createdAt: integer("created_at").notNull(),
});

/** Heartbeat リマインダーテーブル */
export const reminders = sqliteTable("reminders", {
	id: text("id").primaryKey(),
	guildId: text("guild_id"),
	description: text("description").notNull(),
	scheduleType: text("schedule_type").notNull(),
	scheduleValue: text("schedule_value").notNull(),
	lastExecutedAt: text("last_executed_at"),
	enabled: integer("enabled").notNull().default(1),
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

/** Heartbeat 基本設定テーブル */
export const heartbeatConfig = sqliteTable("heartbeat_config", {
	key: text("key")
		.primaryKey()
		.$defaultFn(() => "default"),
	baseIntervalMinutes: integer("base_interval_minutes").notNull().default(1),
});
