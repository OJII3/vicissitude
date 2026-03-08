/** Minecraft のゲーム内時間 (0–23999) から時間帯を返す */
export function getTimePeriod(timeOfDay: number): string {
	if (timeOfDay < 6000) return "朝";
	if (timeOfDay < 12000) return "昼";
	if (timeOfDay < 13000) return "夕";
	return "夜";
}
