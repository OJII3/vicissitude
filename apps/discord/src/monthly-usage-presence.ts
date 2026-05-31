import { Database } from "bun:sqlite";

import type { Logger } from "@vicissitude/shared/types";

import type { DiscordGateway } from "./gateway/discord.ts";

export const OPENCODE_DB_PATH = "/app/.local/share/opencode/opencode.db";
export const OPENCODE_MONTHLY_LIMIT_USD = 60;
export const MONTHLY_USAGE_PRESENCE_INTERVAL_MS = 5 * 60 * 1000;

interface SqliteColumnInfo {
	name: string;
	type?: string;
}

export interface MonthlyUsagePresenceOptions {
	dbPath?: string;
	monthlyLimitUsd?: number;
	intervalMs?: number;
	now?: () => Date;
}

export class MonthlyUsagePresenceService {
	private timer: ReturnType<typeof setInterval> | undefined;

	private readonly dbPath: string;
	private readonly monthlyLimitUsd: number;
	private readonly intervalMs: number;
	private readonly now: () => Date;

	constructor(
		private readonly gateway: DiscordGateway,
		private readonly logger: Logger,
		options: MonthlyUsagePresenceOptions = {},
	) {
		this.dbPath = options.dbPath ?? OPENCODE_DB_PATH;
		this.monthlyLimitUsd = options.monthlyLimitUsd ?? OPENCODE_MONTHLY_LIMIT_USD;
		this.intervalMs = options.intervalMs ?? MONTHLY_USAGE_PRESENCE_INTERVAL_MS;
		this.now = options.now ?? (() => new Date());
	}

	start(): void {
		if (this.timer) return;
		this.update();
		this.timer = setInterval(() => this.update(), this.intervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	update(): void {
		try {
			const cost = readCurrentMonthCost(this.dbPath, this.now());
			const percentage = (cost / this.monthlyLimitUsd) * 100;
			this.gateway.setWatchingActivity(formatUsagePercentage(percentage));
		} catch (error) {
			this.logger.warn("[presence] failed to update monthly usage presence:", error);
		}
	}
}

export function formatUsagePercentage(percentage: number): string {
	if (!Number.isFinite(percentage) || percentage < 0) return "0%";
	if (percentage < 10) return `${percentage.toFixed(1)}%`;
	return `${Math.round(percentage)}%`;
}

export function readCurrentMonthCost(dbPath: string, now: Date = new Date()): number {
	const db = new Database(dbPath, { readonly: true, create: false });
	try {
		const columns = getTableColumns(db, "session");
		if (!columns.some((column) => column.name === "cost")) {
			throw new Error("OpenCode session table has no cost column");
		}

		const dateColumn = selectDateColumn(columns);
		if (!dateColumn) {
			throw new Error("OpenCode session table has no known timestamp column");
		}

		const range = currentMonthRange(now);
		const where = buildCurrentMonthWhere(dateColumn);
		const row = db
			.query<{ total: number | null }, Array<string | number>>(
				`SELECT COALESCE(SUM(COALESCE("cost", 0)), 0) AS total FROM "session" WHERE ${where.sql}`,
			)
			.get(...where.params(range));
		return row?.total ?? 0;
	} finally {
		db.close();
	}
}

function getTableColumns(db: Database, tableName: string): SqliteColumnInfo[] {
	const quotedTableName = `"${tableName.replaceAll('"', '""')}"`;
	const rows = db.query<SqliteColumnInfo, []>(`PRAGMA table_info(${quotedTableName})`).all();
	if (rows.length === 0) throw new Error(`OpenCode ${tableName} table not found`);
	return rows;
}

function selectDateColumn(columns: SqliteColumnInfo[]): SqliteColumnInfo | undefined {
	const candidates = [
		"created_at",
		"createdAt",
		"updated_at",
		"updatedAt",
		"time",
		"timestamp",
		"started_at",
	];
	return candidates
		.map((name) => columns.find((column) => column.name === name))
		.find((column): column is SqliteColumnInfo => !!column);
}

function currentMonthRange(now: Date) {
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	return {
		startIso: start.toISOString(),
		endIso: end.toISOString(),
		startMs: start.getTime(),
		endMs: end.getTime(),
		startSec: Math.floor(start.getTime() / 1000),
		endSec: Math.floor(end.getTime() / 1000),
	};
}

function buildCurrentMonthWhere(column: SqliteColumnInfo): {
	sql: string;
	params: (range: ReturnType<typeof currentMonthRange>) => Array<string | number>;
} {
	const columnName = `"${column.name.replaceAll('"', '""')}"`;
	const type = (column.type ?? "").toUpperCase();
	if (type.includes("INT") || type.includes("REAL") || type.includes("NUM")) {
		return {
			sql: `((${columnName} >= ? AND ${columnName} < ?) OR (${columnName} >= ? AND ${columnName} < ?))`,
			params: (range) => [range.startMs, range.endMs, range.startSec, range.endSec],
		};
	}
	return {
		sql: `${columnName} >= ? AND ${columnName} < ?`,
		params: (range) => [range.startIso, range.endIso],
	};
}
