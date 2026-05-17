import { describe, expect, test } from "bun:test";

import { GitHubIssueAdapter } from "@vicissitude/infrastructure/http/github-issue-adapter";

interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

function makeAdapter(json: unknown, calls: FetchCall[] = []): GitHubIssueAdapter {
	return new GitHubIssueAdapter({
		token: "test-token",
		owner: "ojii3",
		repo: "vicissitude",
		fetchFn: (url, init) => {
			calls.push({ url, init });
			return Promise.resolve(
				new Response(JSON.stringify(json), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		},
	});
}

async function expectAdapterValidationError(promise: Promise<unknown>): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(Error);
	const error = thrown as Error;
	expect(error.name).toBe("GitHubIssueAdapterResponseError");
	expect(error.message).toContain("GitHubIssueAdapter response validation failed");
}

describe("GitHubIssueAdapter", () => {
	test("createIssue は GitHub API 応答を Issue 番号と URL に変換する", async () => {
		const calls: FetchCall[] = [];
		const adapter = makeAdapter(
			{
				number: 960,
				html_url: "https://github.com/ojii3/vicissitude/issues/960",
			},
			calls,
		);

		const created = await adapter.createIssue({
			title: "リファクタリング",
			body: "body",
			labels: ["refactor"],
		});

		expect(created).toEqual({
			number: 960,
			url: "https://github.com/ojii3/vicissitude/issues/960",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.github.com/repos/ojii3/vicissitude/issues");
		expect(calls[0]?.init?.method).toBe("POST");
		const body = calls[0]?.init?.body;
		if (typeof body !== "string") throw new Error("expected string request body");
		expect(JSON.parse(body)).toEqual({
			title: "リファクタリング",
			body: "body",
			labels: ["refactor"],
		});
	});

	test("createIssue は不正形の GitHub API 応答を adapter validation error にする", async () => {
		const adapter = makeAdapter({
			number: "960",
			html_url: "https://github.com/ojii3/vicissitude/issues/960",
		});

		await expectAdapterValidationError(
			adapter.createIssue({
				title: "リファクタリング",
				body: "body",
				labels: ["refactor"],
			}),
		);
	});

	test("findRecentIssues は GitHub API 応答を Issue 一覧に変換する", async () => {
		const calls: FetchCall[] = [];
		const adapter = makeAdapter(
			[
				{ number: 960, title: "リファクタリング" },
				{ number: 961, title: "別件" },
			],
			calls,
		);

		const issues = await adapter.findRecentIssues({
			label: "character-drift",
			sinceDateISO: "2026-05-16T00:00:00.000Z",
		});

		expect(issues).toEqual([
			{ number: 960, title: "リファクタリング" },
			{ number: 961, title: "別件" },
		]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected fetch call");
		const url = new URL(call.url);
		expect(url.pathname).toBe("/repos/ojii3/vicissitude/issues");
		expect(url.searchParams.get("labels")).toBe("character-drift");
		expect(url.searchParams.get("since")).toBe("2026-05-16T00:00:00.000Z");
		expect(url.searchParams.get("state")).toBe("all");
	});

	test("findRecentIssues は不正形の GitHub API 応答を adapter validation error にする", async () => {
		const adapter = makeAdapter([{ number: 960, title: null }]);

		await expectAdapterValidationError(
			adapter.findRecentIssues({
				label: "character-drift",
				sinceDateISO: "2026-05-16T00:00:00.000Z",
			}),
		);
	});
});
