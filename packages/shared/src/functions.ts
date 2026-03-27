// ─── splitMessage ────────────────────────────────────────────────

const DEFAULT_MAX_LENGTH = 2000;

/**
 * メッセージを指定の文字数制限に合わせて分割する純粋関数。
 * 行の区切りで分割を試み、無理なら maxLength で切る。
 */
export function splitMessage(text: string, maxLength = DEFAULT_MAX_LENGTH): string[] {
	if (maxLength <= 0) throw new Error("maxLength must be positive");
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}
		const splitAt = remaining.lastIndexOf("\n", maxLength);
		if (splitAt <= 0) {
			chunks.push(remaining.slice(0, maxLength));
			remaining = remaining.slice(maxLength);
		} else {
			chunks.push(remaining.slice(0, splitAt));
			remaining = remaining.slice(splitAt + 1);
		}
	}
	return chunks;
}

// ─── formatTimestamp / formatTime ────────────────────────────────

/** JST (UTC+9) のオフセット（ミリ秒） */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

export function formatTimestamp(date: Date): string {
	const jst = new Date(date.getTime() + JST_OFFSET_MS);
	const y = jst.getUTCFullYear();
	const mo = pad(jst.getUTCMonth() + 1);
	const d = pad(jst.getUTCDate());
	const h = pad(jst.getUTCHours());
	const mi = pad(jst.getUTCMinutes());
	return `${y}-${mo}-${d} ${h}:${mi}`;
}

export function formatTime(date: Date): string {
	const jst = new Date(date.getTime() + JST_OFFSET_MS);
	const h = pad(jst.getUTCHours());
	const mi = pad(jst.getUTCMinutes());
	return `${h}:${mi}`;
}

// ─── delayResolve ────────────────────────────────────────────────

/** 指定ミリ秒後に値を返す Promise を生成する */
export function delayResolve<T>(ms: number, value: T): Promise<T> {
	return new Promise((_resolve) => {
		setTimeout(() => _resolve(value), ms);
	});
}

// ─── withTimeout ─────────────────────────────────────────────────

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});

	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
