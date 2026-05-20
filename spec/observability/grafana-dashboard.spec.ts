import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface DashboardVariable {
	name: string;
	query: string;
}

interface DashboardTarget {
	expr?: string;
}

interface DashboardPanel {
	targets?: DashboardTarget[];
}

interface GrafanaDashboard {
	panels: DashboardPanel[];
	templating: {
		list: DashboardVariable[];
	};
}

const dashboard = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../../monitoring/grafana-dashboard.json"), "utf8"),
) as GrafanaDashboard;

const expressions = dashboard.panels.flatMap(
	(panel) => panel.targets?.map((target) => target.expr).filter((expr) => expr !== undefined) ?? [],
);

const aiMetricPattern =
	/\b(?:ai_requests_total|ai_request_duration_seconds_bucket|llm_[a-z_]+|session_[a-z_]+)\b/;

describe("Grafana dashboard", () => {
	it("Discord guild と AI scope を別々の変数で絞り込める", () => {
		const variables = new Map(
			dashboard.templating.list.map((variable) => [variable.name, variable.query]),
		);

		expect(variables.get("guild_id")).toBe(
			"label_values(discord_messages_received_total, guild_id)",
		);
		expect(variables.get("scope_id")).toBe("label_values(ai_requests_total, scope_id)");
	});

	it("AI/LLM/session 系 PromQL は scope_id ラベルを使う", () => {
		const aiExpressions = expressions.filter((expr) => aiMetricPattern.test(expr));

		expect(aiExpressions.length).toBeGreaterThan(0);
		for (const expr of aiExpressions) {
			expect(expr).toContain('scope_id=~"$scope_id"');
			expect(expr).not.toContain('guild_id=~"$guild_id"');
		}
	});

	it("Discord gateway 系 PromQL は guild_id ラベルを維持する", () => {
		const discordExpressions = expressions.filter((expr) =>
			expr.includes("discord_messages_received_total"),
		);

		expect(discordExpressions.length).toBeGreaterThan(0);
		for (const expr of discordExpressions) {
			expect(expr).toContain('guild_id=~"$guild_id"');
			expect(expr).not.toContain('scope_id=~"$scope_id"');
		}
	});
});
