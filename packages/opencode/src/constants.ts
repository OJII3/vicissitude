/** OpenCode の全ビルトインツールを無効化する設定 (OpenCode 1.2.24) */
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
	todowrite: false,
	skill: false,
	invalid: false,
};
