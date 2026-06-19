import { z } from "zod";

// ─── McAuthMode ──────────────────────────────────────────────────

const mcAuthModeSchema = z.enum(["offline", "microsoft"]);
export type McAuthMode = z.infer<typeof mcAuthModeSchema>;

export function parseMcAuthMode(value: string): McAuthMode {
	const result = mcAuthModeSchema.safeParse(value);
	if (!result.success) {
		throw new Error('MC_AUTH_MODE must be "offline" or "microsoft"');
	}
	return result.data;
}
