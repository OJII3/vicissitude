import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

import { DEFAULT_HEARTBEAT_CONFIG } from "../../domain/entities/heartbeat-config.ts";
import type { HeartbeatConfig } from "../../domain/entities/heartbeat-config.ts";
import type { HeartbeatConfigRepository } from "../../domain/ports/heartbeat-config-repository.port.ts";

export class JsonHeartbeatConfigRepository implements HeartbeatConfigRepository {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = resolve(filePath);
	}

	load(): Promise<HeartbeatConfig> {
		if (!existsSync(this.filePath)) {
			return Promise.resolve(structuredClone(DEFAULT_HEARTBEAT_CONFIG));
		}
		try {
			const raw = readFileSync(this.filePath, "utf-8");
			return Promise.resolve(JSON.parse(raw) as HeartbeatConfig);
		} catch {
			return Promise.resolve(structuredClone(DEFAULT_HEARTBEAT_CONFIG));
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
