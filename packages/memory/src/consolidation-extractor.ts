import { consolidationSchema, type ConsolidationOutput } from "./consolidation-contract.ts";
import {
	buildCalibrationMessages,
	buildExtractionMessages,
	buildPredictionMessages,
} from "./consolidation-prompts.ts";
import type { Episode } from "./episode.ts";
import type { MemoryLlmPort } from "./llm-port.ts";
import type { SemanticFact } from "./semantic-fact.ts";

export type ConsolidationExtractionStrategy = "direct" | "predict-calibrate";

/** LLM-backed extraction boundary for consolidation. */
export class ConsolidationExtractor {
	constructor(private readonly llm: MemoryLlmPort) {}

	extract(episode: Episode, existingFacts: SemanticFact[]): Promise<ConsolidationOutput> {
		const strategy = selectExtractionStrategy(existingFacts);
		return strategy === "predict-calibrate"
			? this.predictThenCalibrate(episode, existingFacts)
			: this.extractDirect(episode, existingFacts);
	}

	private extractDirect(
		episode: Episode,
		existingFacts: SemanticFact[],
	): Promise<ConsolidationOutput> {
		return this.llm.chatStructured<ConsolidationOutput>(
			buildExtractionMessages(episode, existingFacts),
			consolidationSchema,
		);
	}

	private async predictThenCalibrate(
		episode: Episode,
		existingFacts: SemanticFact[],
	): Promise<ConsolidationOutput> {
		const prediction = await this.llm.chat(buildPredictionMessages(episode, existingFacts));
		return this.llm.chatStructured<ConsolidationOutput>(
			buildCalibrationMessages(episode, prediction, existingFacts),
			consolidationSchema,
		);
	}
}

export function selectExtractionStrategy(
	existingFacts: SemanticFact[],
): ConsolidationExtractionStrategy {
	return existingFacts.length > 0 ? "predict-calibrate" : "direct";
}
