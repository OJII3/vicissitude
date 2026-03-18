const CODE_OR_TWITTER_RE =
	/(`{1,3})[\s\S]*?\1|https?:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\//g;

export function rewriteTwitterUrls(content: string): string {
	return content.replaceAll(CODE_OR_TWITTER_RE, (match) => {
		if (match.startsWith("`")) return match;
		return "https://fxtwitter.com/";
	});
}
