import { EmotionEstimator } from "@vicissitude/agent/emotion/estimator";
import { classifyErrorType, METRIC } from "@vicissitude/observability/metrics";
import type { EmotionAnalyzer, LlmPromptPort } from "@vicissitude/shared/ports";
import type { Logger, MetricsCollector } from "@vicissitude/shared/types";

import { extractEmotionPromptErrorInfo } from "./emotion-error-info.ts";
export { extractEmotionPromptErrorInfo } from "./emotion-error-info.ts";
export type { EmotionPromptErrorInfo } from "./emotion-error-info.ts";

const LONG_RETRY_AFTER_THRESHOLD_SECONDS = 60;

export interface EmotionAnalyzerOptions {
	metrics?: MetricsCollector;
	now?: () => number;
}

export interface EmotionPromptModel {
	providerId: string;
	modelId: string;
}

interface CooldownState {
	untilMs: number;
	reason: string;
}

interface ObservationContext {
	model: EmotionPromptModel;
	logger: Logger;
	metrics?: MetricsCollector;
}

export function createEmotionAnalyzerFromPromptPort(
	llm: LlmPromptPort,
	model: EmotionPromptModel,
	logger: Logger,
	options: EmotionAnalyzerOptions = {},
): EmotionAnalyzer {
	return new EmotionEstimator(createObservedEmotionPromptPort(llm, model, logger, options), logger);
}

function createObservedEmotionPromptPort(
	inner: LlmPromptPort,
	model: EmotionPromptModel,
	logger: Logger,
	options: EmotionAnalyzerOptions,
): LlmPromptPort {
	let cooldown: CooldownState | null = null;
	const now = options.now ?? Date.now;
	const context: ObservationContext = { model, logger, metrics: options.metrics };

	function activeCooldown(): CooldownState | null {
		if (!cooldown) return null;
		if (now() < cooldown.untilMs) return cooldown;
		cooldown = null;
		return null;
	}

	return {
		async prompt(text: string): Promise<string> {
			const cooldownState = activeCooldown();
			if (cooldownState) {
				skipDueToCooldown(cooldownState, context, now);
			}

			try {
				return await inner.prompt(text);
			} catch (error) {
				recordFailure(error, context, now, (state) => {
					cooldown = state;
				});
				throw createSuppressedEmotionPromptError("emotion estimation prompt failed", error);
			}
		},
	};
}

function recordFailure(
	error: unknown,
	context: ObservationContext,
	now: () => number,
	setCooldown: (cooldown: CooldownState) => void,
): void {
	const info = extractEmotionPromptErrorInfo(error);
	const retryAfter = classifyRetryAfter(info.retryAfterSeconds);
	const errorType = classifyErrorType({
		status: info.status,
		retryable: info.retryable,
		errorClass: info.errorClass,
		message: info.message,
	});
	const { model, metrics, logger } = context;
	metrics?.incrementCounter(METRIC.EMOTION_ESTIMATION_ERRORS, {
		provider: model.providerId,
		model: model.modelId,
		error_type: errorType,
		http_status: info.status === undefined ? "unknown" : String(info.status),
		retryable: info.retryable === undefined ? "unknown" : String(info.retryable),
		error_class: info.errorClass,
		retry_after: retryAfter,
		reason: info.reason,
	});

	if (shouldCooldown(info)) {
		const untilMs = now() + info.retryAfterSeconds * 1000;
		setCooldown({ untilMs, reason: info.reason });
		logger.warn("[emotion] estimation provider cooldown activated", {
			provider: model.providerId,
			model: model.modelId,
			error_type: errorType,
			http_status: info.status,
			retry_after_seconds: info.retryAfterSeconds,
			retry_after: retryAfter,
			reason: info.reason,
			cooldown_until: new Date(untilMs).toISOString(),
		});
		return;
	}

	logger.warn("[emotion] estimation provider failure", {
		provider: model.providerId,
		model: model.modelId,
		error_type: errorType,
		http_status: info.status ?? "unknown",
		retry_after_seconds: info.retryAfterSeconds ?? "unknown",
		retry_after: retryAfter,
		reason: info.reason,
		error_class: info.errorClass,
	});
}

function shouldCooldown(info: { status?: number; retryAfterSeconds?: number }): info is {
	status: 429;
	retryAfterSeconds: number;
} {
	return (
		info.status === 429 &&
		info.retryAfterSeconds !== undefined &&
		info.retryAfterSeconds >= LONG_RETRY_AFTER_THRESHOLD_SECONDS
	);
}

function skipDueToCooldown(
	cooldown: CooldownState,
	context: ObservationContext,
	now: () => number,
): never {
	const { model, metrics, logger } = context;
	const remainingSeconds = Math.ceil((cooldown.untilMs - now()) / 1000);
	metrics?.incrementCounter(METRIC.EMOTION_ESTIMATION_SKIPS, {
		provider: model.providerId,
		model: model.modelId,
		reason: "provider_cooldown",
	});
	logger.warn("[emotion] estimation skipped during provider cooldown", {
		provider: model.providerId,
		model: model.modelId,
		remaining_seconds: remainingSeconds,
		reason: "provider_cooldown",
		cooldown_reason: cooldown.reason,
	});
	throw createSuppressedEmotionPromptError("emotion estimation skipped during provider cooldown");
}

function createSuppressedEmotionPromptError(message: string, cause?: unknown): Error {
	const error = new Error(message, { cause }) as Error & {
		suppressEmotionEstimatorLog: true;
	};
	error.name = "SuppressedEmotionPromptError";
	error.suppressEmotionEstimatorLog = true;
	return error;
}

function classifyRetryAfter(seconds: number | undefined): "none" | "short" | "long" {
	if (seconds === undefined) return "none";
	return seconds >= LONG_RETRY_AFTER_THRESHOLD_SECONDS ? "long" : "short";
}
