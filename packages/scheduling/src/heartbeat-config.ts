/* oxlint-disable max-lines -- repository, lock handling, and legacy migration are one cohesive unit */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, resolve as resolvePath } from "path";

import { isRecord, sleep } from "@vicissitude/shared/functions";
import { discordScopeId } from "@vicissitude/shared/namespace";
import type {
	HeartbeatConfig,
	HeartbeatReminder,
	ReminderSchedule,
} from "@vicissitude/shared/types";
import { z } from "zod";

import { createDefaultHeartbeatConfig } from "./heartbeat-helpers.ts";

const LOCK_POLL_INTERVAL_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

const heartbeatConfigSchema = z.object({
	baseIntervalMinutes: z.number().min(1),
	reminders: z.array(
		z.object({
			id: z.string(),
			description: z.string(),
			schedule: z.union([
				z.object({ type: z.literal("interval"), minutes: z.number().min(1) }),
				z.object({
					type: z.literal("daily"),
					hour: z.number().min(0).max(23),
					minute: z.number().min(0).max(59),
				}),
			]),
			lastExecutedAt: z.string().nullable(),
			enabled: z.boolean(),
			scopeId: z.string().optional(),
		}),
	),
});

export class JsonHeartbeatConfigRepository {
	private readonly filePath: string;
	private readonly loadedSnapshots = new WeakMap<HeartbeatConfig, HeartbeatConfig>();

	constructor(filePath: string) {
		this.filePath = resolvePath(filePath);
	}

	load(): Promise<HeartbeatConfig> {
		return Promise.resolve().then(() => {
			const config = this.readConfig();
			this.loadedSnapshots.set(config, cloneConfig(config));
			return config;
		});
	}

	async save(config: HeartbeatConfig): Promise<void> {
		const baseline = this.loadedSnapshots.get(config);
		let savedConfig = cloneConfig(config);

		await this.withFileLock(async () => {
			const current = this.readConfig();
			savedConfig = baseline ? mergeConfigChanges(baseline, current, config) : cloneConfig(config);
			await this.writeConfig(savedConfig);
		});

		this.loadedSnapshots.set(config, cloneConfig(savedConfig));
	}

	async markRemindersExecuted(reminderIds: readonly string[], executedAt: string): Promise<void> {
		if (reminderIds.length === 0) return;
		const ids = new Set(reminderIds);

		await this.withFileLock(async () => {
			const config = this.readConfig();
			let changed = false;

			for (const reminder of config.reminders) {
				if (ids.has(reminder.id) && reminder.lastExecutedAt !== executedAt) {
					reminder.lastExecutedAt = executedAt;
					changed = true;
				}
			}

			if (changed) {
				await this.writeConfig(config);
			}
		});
	}

	private readConfig(): HeartbeatConfig {
		if (!existsSync(this.filePath)) {
			return createDefaultHeartbeatConfig();
		}

		const raw: string = readFileSync(this.filePath, "utf-8");
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch (error) {
			throw createHeartbeatConfigJsonError(this.filePath, error);
		}

		const migrated = migrateLegacyHeartbeatConfigJson(json);
		const parsed = heartbeatConfigSchema.safeParse(migrated.value);
		if (!parsed.success) {
			throw createHeartbeatConfigSchemaError(this.filePath, parsed.error);
		}
		if (migrated.changed) {
			this.writeConfigSync(parsed.data as HeartbeatConfig);
		}
		return parsed.data as HeartbeatConfig;
	}

	private async writeConfig(config: HeartbeatConfig): Promise<void> {
		this.ensureDir();
		const tempPath = `${this.filePath}.${String(process.pid)}.${String(Date.now())}.${String(Math.random()).slice(2)}.tmp`;
		try {
			await Bun.write(tempPath, JSON.stringify(config, null, 2));
			renameSync(tempPath, this.filePath);
		} catch (error) {
			rmSync(tempPath, { force: true });
			throw error;
		}
	}

	private ensureDir(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	private writeConfigSync(config: HeartbeatConfig): void {
		this.ensureDir();
		const tempPath = `${this.filePath}.${String(process.pid)}.${String(Date.now())}.${String(Math.random()).slice(2)}.tmp`;
		try {
			writeFileSync(tempPath, JSON.stringify(config, null, 2));
			renameSync(tempPath, this.filePath);
		} catch (error) {
			rmSync(tempPath, { force: true });
			throw error;
		}
	}

	private async withFileLock<T>(action: () => Promise<T>): Promise<T> {
		this.ensureDir();
		const lockPath = `${this.filePath}.lock`;
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		await this.acquireFileLock(lockPath, deadline);

		try {
			return await action();
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
		}
	}

	private async acquireFileLock(lockPath: string, deadline: number): Promise<void> {
		try {
			mkdirSync(lockPath);
		} catch (error) {
			if (!isFileExistsError(error)) {
				throw error;
			}
			this.removeStaleLock(lockPath);
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for heartbeat config lock: ${lockPath}`, {
					cause: error,
				});
			}
			await sleep(LOCK_POLL_INTERVAL_MS);
			return this.acquireFileLock(lockPath, deadline);
		}
	}

	private removeStaleLock(lockPath: string): void {
		try {
			const ageMs = Date.now() - statSync(lockPath).mtimeMs;
			if (ageMs > LOCK_STALE_MS) {
				rmSync(lockPath, { recursive: true, force: true });
			}
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}
}

function createHeartbeatConfigJsonError(filePath: string, cause: unknown): Error {
	const error = new Error(`Invalid heartbeat config JSON: ${filePath}`, { cause });
	error.name = "HeartbeatConfigJsonError";
	return error;
}

function createHeartbeatConfigSchemaError(filePath: string, cause: unknown): Error {
	const error = new Error(`Invalid heartbeat config schema: ${filePath}`, { cause });
	error.name = "HeartbeatConfigSchemaError";
	return error;
}

function mergeConfigChanges(
	baseline: HeartbeatConfig,
	current: HeartbeatConfig,
	next: HeartbeatConfig,
): HeartbeatConfig {
	const merged = cloneConfig(current);
	if (next.baseIntervalMinutes !== baseline.baseIntervalMinutes) {
		merged.baseIntervalMinutes = next.baseIntervalMinutes;
	}

	const baselineById = indexReminders(baseline.reminders);
	const nextById = indexReminders(next.reminders);
	const removedIds = new Set(baseline.reminders.map((r) => r.id).filter((id) => !nextById.has(id)));
	merged.reminders = merged.reminders.filter((r) => !removedIds.has(r.id));

	const mergedIndexes = indexReminderPositions(merged.reminders);
	for (const nextReminder of next.reminders) {
		const baselineReminder = baselineById.get(nextReminder.id);
		const mergedIndex = mergedIndexes.get(nextReminder.id);
		const currentReminder = mergedIndex === undefined ? undefined : merged.reminders[mergedIndex];
		const reminder =
			baselineReminder && currentReminder
				? mergeReminderChanges(baselineReminder, currentReminder, nextReminder)
				: cloneReminder(nextReminder);

		if (mergedIndex === undefined) {
			mergedIndexes.set(reminder.id, merged.reminders.length);
			merged.reminders.push(reminder);
		} else {
			merged.reminders[mergedIndex] = reminder;
		}
	}

	return merged;
}

function mergeReminderChanges(
	baseline: HeartbeatReminder,
	current: HeartbeatReminder,
	next: HeartbeatReminder,
): HeartbeatReminder {
	const merged = cloneReminder(current);

	if (next.description !== baseline.description) {
		merged.description = next.description;
	}
	if (!schedulesEqual(next.schedule, baseline.schedule)) {
		merged.schedule = cloneSchedule(next.schedule);
	}
	if (next.lastExecutedAt !== baseline.lastExecutedAt) {
		merged.lastExecutedAt = next.lastExecutedAt;
	}
	if (next.enabled !== baseline.enabled) {
		merged.enabled = next.enabled;
	}
	if (next.scopeId !== baseline.scopeId) {
		if (next.scopeId === undefined) {
			delete merged.scopeId;
		} else {
			merged.scopeId = next.scopeId;
		}
	}

	return merged;
}

function indexReminders(reminders: readonly HeartbeatReminder[]): Map<string, HeartbeatReminder> {
	return new Map(reminders.map((reminder) => [reminder.id, reminder]));
}

function indexReminderPositions(reminders: readonly HeartbeatReminder[]): Map<string, number> {
	return new Map(reminders.map((reminder, index) => [reminder.id, index]));
}

function cloneConfig(config: HeartbeatConfig): HeartbeatConfig {
	return {
		baseIntervalMinutes: config.baseIntervalMinutes,
		reminders: config.reminders.map(cloneReminder),
	};
}

function cloneReminder(reminder: HeartbeatReminder): HeartbeatReminder {
	return {
		id: reminder.id,
		description: reminder.description,
		schedule: cloneSchedule(reminder.schedule),
		lastExecutedAt: reminder.lastExecutedAt,
		enabled: reminder.enabled,
		...(reminder.scopeId === undefined ? {} : { scopeId: reminder.scopeId }),
	};
}

function migrateLegacyHeartbeatConfigJson(value: unknown): { value: unknown; changed: boolean } {
	if (!isRecord(value) || !Array.isArray(value.reminders)) {
		return { value, changed: false };
	}

	let changed = false;
	const rawReminders = value.reminders as unknown[];
	const reminders = rawReminders.map((reminder): unknown => {
		if (!isRecord(reminder) || !("guildId" in reminder)) return reminder;
		const { guildId, ...rest } = reminder;
		if (typeof guildId !== "string") {
			throw new TypeError("Invalid legacy heartbeat reminder guildId");
		}
		const scopeId = discordScopeId(guildId);
		if ("scopeId" in rest && rest.scopeId !== scopeId) {
			throw new Error("Conflicting heartbeat reminder scopeId and legacy guildId");
		}
		changed = true;
		return Object.assign({}, rest, { scopeId });
	});

	return { value: { ...value, reminders }, changed };
}

function cloneSchedule(schedule: ReminderSchedule): ReminderSchedule {
	if (schedule.type === "interval") {
		return { type: "interval", minutes: schedule.minutes };
	}
	return { type: "daily", hour: schedule.hour, minute: schedule.minute };
}

function schedulesEqual(left: ReminderSchedule, right: ReminderSchedule): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "interval") {
		return left.minutes === (right as { type: "interval"; minutes: number }).minutes;
	}
	return (
		left.hour === (right as { type: "daily"; hour: number; minute: number }).hour &&
		left.minute === (right as { type: "daily"; hour: number; minute: number }).minute
	);
}

function isFileExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
