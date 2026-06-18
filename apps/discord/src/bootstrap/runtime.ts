import { dirname } from "path";

import { fetchNewEmails, formatEmailContext } from "@vicissitude/application/email-fetcher";
import { METRIC, type PrometheusCollector } from "@vicissitude/observability/metrics";
import type { PreFilterResult } from "@vicissitude/scheduling/heartbeat-scheduler";
import type { DueReminder, Logger, SessionStorePort } from "@vicissitude/shared/types";

import type { AppConfig } from "../config.ts";

export function startSessionGauge(
	sessionStore: SessionStorePort,
	metricsCollector: PrometheusCollector,
): ReturnType<typeof setInterval> {
	const update = () => metricsCollector.setGauge(METRIC.LLM_ACTIVE_SESSIONS, sessionStore.count());
	update();
	return setInterval(update, 30_000);
}

export function resolveBootstrapRoot(
	config: Pick<AppConfig, "contextDir">,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return env.APP_ROOT ?? dirname(config.contextDir);
}

export function buildEmailCheckPreFilter(
	logger: Logger,
	emailConfig?: AppConfig["emailCheck"],
): ((dueReminders: DueReminder[]) => Promise<PreFilterResult>) | undefined {
	if (!emailConfig) return undefined;
	const { endpoint, token } = emailConfig;

	return async (dueReminders: DueReminder[]): Promise<PreFilterResult> => {
		const emailReminders = dueReminders.filter((d) => d.reminder.id === "email-check");
		const otherReminders = dueReminders.filter((d) => d.reminder.id !== "email-check");

		if (emailReminders.length === 0) return { reminders: dueReminders };

		try {
			const result = await fetchNewEmails(endpoint, token);
			if (!result.hasNewMail) {
				return { reminders: otherReminders, markExecutedIds: ["email-check"] };
			}
			const context = formatEmailContext(result);
			const enriched = emailReminders.map((d) => Object.assign({}, d, { context }));
			return { reminders: [...otherReminders, ...enriched] };
		} catch (error) {
			logger.error("[heartbeat] email check failed:", error);
			return { reminders: otherReminders, markExecutedIds: ["email-check"] };
		}
	};
}
