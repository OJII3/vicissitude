const MAX_DISCORD_LENGTH = 2000;

/**
 * メッセージを Discord の文字数制限に合わせて分割する純粋関数。
 * 行の区切りで分割を試み、無理なら MAX_DISCORD_LENGTH で切る。
 */
export function splitMessage(text: string): string[] {
	if (text.length <= MAX_DISCORD_LENGTH) return [text];

	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
		if (splitAt <= 0) splitAt = MAX_DISCORD_LENGTH;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt);
	}
	return chunks;
}
