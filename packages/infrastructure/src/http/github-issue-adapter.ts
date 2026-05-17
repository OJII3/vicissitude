import type { GitHubIssuePort } from "@vicissitude/shared/ports";
import { z } from "zod";

/** GitHub API 呼び出しに必要な fetch 互換型 */
type GitHubFetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const CreatedIssueResponseSchema = z.object({
	number: z.number().int(),
	html_url: z.string(),
});

const RecentIssueResponseSchema = z.object({
	number: z.number().int(),
	title: z.string(),
});

const RecentIssuesResponseSchema = z.array(RecentIssueResponseSchema);

type CreatedIssueResponse = z.infer<typeof CreatedIssueResponseSchema>;
type RecentIssuesResponse = z.infer<typeof RecentIssuesResponseSchema>;

function formatZodError(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
			return `${path}: ${issue.message}`;
		})
		.join("; ");
}

function createResponseValidationError(error: z.ZodError): Error {
	const validationError = new Error(
		`GitHubIssueAdapter response validation failed: ${formatZodError(error)}`,
	);
	validationError.name = "GitHubIssueAdapterResponseError";
	return validationError;
}

function parseGitHubResponse<T>(schema: z.ZodType<T>, json: unknown): T {
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw createResponseValidationError(parsed.error);
	return parsed.data;
}

export interface GitHubIssueAdapterOptions {
	token: string;
	owner: string;
	repo: string;
	fetchFn?: GitHubFetchLike;
}

/**
 * GitHub REST API を使った {@link GitHubIssuePort} の実装。
 * エラー時はそのままスローする（エラーハンドリングは呼び出し側が行う）。
 */
export class GitHubIssueAdapter implements GitHubIssuePort {
	private readonly token: string;
	private readonly owner: string;
	private readonly repo: string;
	private readonly fetchFn: GitHubFetchLike;

	constructor(options: GitHubIssueAdapterOptions) {
		this.token = options.token;
		this.owner = options.owner;
		this.repo = options.repo;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async createIssue(params: {
		title: string;
		body: string;
		labels: string[];
	}): Promise<{ number: number; url: string }> {
		const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues`;
		const res = await this.fetchFn(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title: params.title,
				body: params.body,
				labels: params.labels,
			}),
		});

		if (!res.ok) {
			throw new Error(`GitHub API error: ${String(res.status)} ${res.statusText}`);
		}

		const data = parseGitHubResponse<CreatedIssueResponse>(
			CreatedIssueResponseSchema,
			await res.json(),
		);
		return { number: data.number, url: data.html_url };
	}

	async findRecentIssues(params: {
		label: string;
		sinceDateISO: string;
	}): Promise<Array<{ number: number; title: string }>> {
		const query = new URLSearchParams({
			labels: params.label,
			since: params.sinceDateISO,
			state: "all",
		});
		const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues?${query.toString()}`;
		const res = await this.fetchFn(url, {
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/vnd.github+json",
			},
		});

		if (!res.ok) {
			throw new Error(`GitHub API error: ${String(res.status)} ${res.statusText}`);
		}

		const data = parseGitHubResponse<RecentIssuesResponse>(
			RecentIssuesResponseSchema,
			await res.json(),
		);
		return data.map((issue) => ({ number: issue.number, title: issue.title }));
	}
}
