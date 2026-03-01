import type { HeartbeatConfig } from "../entities/heartbeat-config.ts";

export interface HeartbeatConfigRepository {
	load(): Promise<HeartbeatConfig>;
	save(config: HeartbeatConfig): Promise<void>;
	updateLastExecuted(reminderId: string, executedAt: string): Promise<void>;
}
