import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import type { HeartbeatConfig } from "../../domain/entities/heartbeat-config.ts";
import type { HeartbeatConfigRepository } from "../../domain/ports/heartbeat-config-repository.port.ts";

const DEFAULT_CONFIG: HeartbeatConfig = {
	baseIntervalMinutes: 1,
	reminders: [
		{
			id: "home-check",
			description: "ホームチャンネルの様子を見る",
			schedule: { type: "interval", minutes: 30 },
			lastExecutedAt: null,
			enabled: true,
		},
		{
			id: "memory-update",
			description: "MEMORY.md に書き出すべき新しい情報がないか確認する",
			schedule: { type: "interval", minutes: 60 },
			lastExecutedAt: null,
			enabled: true,
		},
	],
};

export class JsonHeartbeatConfigRepository implements HeartbeatConfigRepository {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = resolve(filePath);
	}

	load(): Promise<HeartbeatConfig> {
		if (!existsSync(this.filePath)) {
			return Promise.resolve(structuredClone(DEFAULT_CONFIG));
		}
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			return Promise.resolve(JSON.parse(raw) as HeartbeatConfig);
		} catch {
			return Promise.resolve({ baseIntervalMinutes: 1, reminders: [] });
		}
	}

	async save(config: HeartbeatConfig): Promise<void> {
		this.ensureDir();
		await Bun.write(this.filePath, JSON.stringify(config, null, 2));
	}

	async updateLastExecuted(reminderId: string, executedAt: string): Promise<void> {
		const config = await this.load();
		const reminder = config.reminders.find((r) => r.id === reminderId);
		if (reminder) {
			reminder.lastExecutedAt = executedAt;
			await this.save(config);
		}
	}

	private ensureDir(): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}
