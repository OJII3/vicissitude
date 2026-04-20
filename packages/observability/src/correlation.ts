/**
 * UUID v7 形式の correlation ID を生成する。
 *
 * 構造:
 * - bits  0-47: Unix epoch ミリ秒タイムスタンプ
 * - bits 48-51: version (0111 = 7)
 * - bits 52-63: ランダム
 * - bits 64-65: variant (10)
 * - bits 66-127: ランダム
 */
export function generateCorrelationId(): string {
	const now = Date.now();

	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);

	// タイムスタンプ（48 ビット、ビッグエンディアン）
	bytes[0] = (now / 2 ** 40) & 0xff;
	bytes[1] = (now / 2 ** 32) & 0xff;
	bytes[2] = (now / 2 ** 24) & 0xff;
	bytes[3] = (now / 2 ** 16) & 0xff;
	bytes[4] = (now / 2 ** 8) & 0xff;
	bytes[5] = now & 0xff;

	// version: 上位 4 ビットを 0111 に設定
	bytes[6] = (bytes[6]! & 0x0f) | 0x70;

	// variant: 上位 2 ビットを 10 に設定
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
