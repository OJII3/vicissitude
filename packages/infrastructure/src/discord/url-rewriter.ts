const TWITTER_URL_RE = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//g;

export function rewriteTwitterUrls(content: string): string {
	return content.replace(TWITTER_URL_RE, "https://fxtwitter.com/");
}
