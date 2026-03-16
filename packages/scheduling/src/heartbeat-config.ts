import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import { createDefaultHeartbeatConfig } from "@vicissitude/shared/functions";
import type { HeartbeatConfig } from "@vicissitude/shared/types";
import { z } from "zod";

const heartbeatConfigSchema = z.object({
	baseIntervalMinutes: z.number(),
	reminders: z.array(
		z.object({
			id: z.string(),
			description: z.string(),
			schedule: z.union([
				z.object({ type: z.literal("interval"), minutes: z.number() }),
				z.object({ type: z.literal("daily"), hour: z.number(), minute: z.number() }),
			]),
			lastExecutedAt: z.string().nullable(),
			enabled: z.boolean(),
			guildId: z.string().optional(),
		}),
	),
});

export class JsonHeartbeatConfigRepository {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = resolve(filePath);
	}

	load(): Promise<HeartbeatConfig> {
		if (!existsSync(this.filePath)) {
			return Promise.resolve(createDefaultHeartbeatConfig());
		}
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			const parsed = heartbeatConfigSchema.parse(JSON.parse(raw));
			return Promise.resolve(parsed as HeartbeatConfig);
		} catch {
			return Promise.resolve(createDefaultHeartbeatConfig());
		}
	}

	async save(config: HeartbeatConfig): Promise<void> {
		this.ensureDir();
		await Bun.write(this.filePath, JSON.stringify(config, null, 2));
	}

	private ensureDir(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}
