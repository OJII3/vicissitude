export type SystemMode = "running" | "draining" | "stopped";

export interface SystemState {
  mode: SystemMode;
  updatedAt: Date;
  updatedBy: string;
  reason: string;
}
