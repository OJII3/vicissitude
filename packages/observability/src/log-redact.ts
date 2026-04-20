const REDACTED = "[REDACTED]";

const patterns: RegExp[] = [
	// API キー / トークン（メールより先にマッチさせる）
	/\b(?:sk-[\w-]{10,}|ghp_[\w]{10,}|gho_[\w]{10,}|xoxb-[\w-]{10,}|xoxp-[\w-]{10,}|glpat-[\w]{10,}|AKIA[\w]{12,})\b/g,

	// メールアドレス
	/\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g,

	// 国際電話番号 (+81..., +1...)
	/\+\d{1,3}[\d-]{7,14}\d/g,

	// 日本の携帯電話番号 (090/080/070)
	/\b0[789]0-?\d{4}-?\d{4}\b/g,
];

/**
 * 文字列中の PII・シークレットを `[REDACTED]` に置換する。
 */
export function maskSecrets(value: string): string {
	let result = value;
	for (const pattern of patterns) {
		result = result.replaceAll(pattern, REDACTED);
	}
	return result;
}

/**
 * オブジェクトを再帰的に走査し、文字列値に {@link maskSecrets} を適用する。
 * 循環参照は `WeakSet` で検出し、そのまま返す。
 */
export function redactObject(obj: unknown): unknown {
	return redactRecursive(obj, new WeakSet());
}

function redactRecursive(obj: unknown, seen: WeakSet<object>): unknown {
	if (typeof obj === "string") {
		return maskSecrets(obj);
	}

	if (obj === null || typeof obj !== "object") {
		return obj;
	}

	if (seen.has(obj)) {
		return "[circular]";
	}
	seen.add(obj);

	if (Array.isArray(obj)) {
		return obj.map((item) => redactRecursive(item, seen));
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[key] = redactRecursive(value, seen);
	}
	return result;
}
