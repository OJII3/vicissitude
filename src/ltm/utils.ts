/** Escape user-supplied content before embedding in XML tags to prevent injection */
export function escapeXmlContent(content: string): string {
	return content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const MAX_USER_ID_LENGTH = 256;

/** Validate userId format: non-empty string, max 256 characters */
export function validateUserId(userId: string): void {
	if (userId === "") {
		throw new Error("userId must not be empty");
	}
	if (userId.length > MAX_USER_ID_LENGTH) {
		throw new Error(`userId too long (${userId.length} chars), maximum ${MAX_USER_ID_LENGTH}`);
	}
}
