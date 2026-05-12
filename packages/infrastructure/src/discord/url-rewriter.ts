const CODE_OR_URL_RE = /```[\s\S]*?```|`[^`]*`|https?:\/\/[^\s<>()]+/g;
const TWITTER_HOST_RE = /^(?:(?:www|mobile)\.)?(x\.com|twitter\.com)$/;
const TRAILING_PUNCTUATION_RE = /[,.!?;:]+$/;

export function rewriteTwitterUrls(content: string): string {
	return content.replaceAll(CODE_OR_URL_RE, (match) => {
		if (match.startsWith("`")) return match;

		const suffix = match.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "";
		const body = suffix ? match.slice(0, -suffix.length) : match;
		const rewritten = rewriteTwitterUrl(body);

		return rewritten ? `${rewritten}${suffix}` : match;
	});
}

function rewriteTwitterUrl(rawUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}

	const sourceHost = url.hostname.match(TWITTER_HOST_RE)?.[1];
	if (!sourceHost) return null;

	const statusId = extractStatusId(url.pathname);
	if (statusId) return `https://api.fxtwitter.com/2/status/${statusId}`;

	url.protocol = "https:";
	url.hostname = sourceHost === "x.com" ? "fixupx.com" : "fxtwitter.com";
	return url.toString();
}

function extractStatusId(pathname: string): string | null {
	const segments = pathname.split("/").filter(Boolean);
	const statusIndex = segments.indexOf("status");
	const statusId = statusIndex >= 0 ? segments[statusIndex + 1] : undefined;

	return statusId && /^\d+$/.test(statusId) ? statusId : null;
}
