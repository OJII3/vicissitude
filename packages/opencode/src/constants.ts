import type { SkillPermissionConfig } from "@vicissitude/shared/types";

/** OpenCode の全ビルトインツールを無効化する設定 */
export const OPENCODE_ALL_TOOLS_DISABLED: Record<string, boolean> = {
	question: false,
	read: false,
	glob: false,
	grep: false,
	edit: false,
	write: false,
	apply_patch: false,
	bash: false,
	webfetch: false,
	task: false,
	task_status: false,
	todowrite: false,
	skill: false,
	invalid: false,
};

export function denyAllSkillPermission(): SkillPermissionConfig {
	return { "*": "deny" };
}

export function createSkillPermission(
	allowedSkills: readonly string[] | undefined,
): SkillPermissionConfig {
	const permission = denyAllSkillPermission();
	for (const skill of allowedSkills ?? []) {
		permission[skill] = "allow";
	}
	return permission;
}

export function isSkillToolEnabled(permission: SkillPermissionConfig): boolean {
	return Object.entries(permission).some(([pattern, action]) => {
		if (action === "deny") return false;
		return pattern === "*" || pattern.trim().length > 0;
	});
}
