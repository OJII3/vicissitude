export interface EmailData {
	subject: string;
	from: string;
	date: string;
	bodyExcerpt: string;
}

export interface EmailCheckResult {
	hasNewMail: boolean;
	count: number;
	emails: EmailData[];
}

export async function fetchNewEmails(
	endpointUrl: string,
	accessToken: string,
): Promise<EmailCheckResult> {
	const url = new URL(endpointUrl);
	url.searchParams.set("token", accessToken);

	const response = await fetch(url.toString());
	if (!response.ok) {
		throw new Error(`Email check failed: ${String(response.status)} ${await response.text()}`);
	}
	return (await response.json()) as EmailCheckResult;
}

export function formatEmailContext(result: EmailCheckResult): string {
	if (!result.hasNewMail || result.emails.length === 0) return "";
	const lines = result.emails.map(
		(email, i) =>
			`${String(i + 1)}. 「${email.subject}」from ${email.from} (${email.date})\n   ${email.bodyExcerpt}`,
	);
	return `新着メール ${String(result.count)} 件:\n${lines.join("\n")}`;
}
