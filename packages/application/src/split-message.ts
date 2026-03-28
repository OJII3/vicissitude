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
