// ─── labelsToKey ─────────────────────────────────────────────────

/** Prometheus ラベルを `{k1="v1",k2="v2"}` 形式のキーに変換する */
export function labelsToKey(labels: Record<string, string>): string {
	const entries = Object.entries(labels).toSorted(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "";
	return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

/** Prometheus テキストフォーマット用のラベル値エスケープ */
function escapeLabel(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
