const CODE_OR_TWITTER_RE =
	/```[\s\S]*?```|`[^`]*`|https?:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\//g;

export function rewriteTwitterUrls(content: string): string {
	return content.replaceAll(CODE_OR_TWITTER_RE, (match) => {
		if (match.startsWith("`")) return match;
		return "https://fxtwitter.com/";
	});
}
