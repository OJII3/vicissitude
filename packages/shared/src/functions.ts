// ─── formatTimestamp / formatTime ────────────────────────────────

/** JST (UTC+9) のオフセット（ミリ秒） */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

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
