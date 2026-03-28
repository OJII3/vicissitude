import { EmotionSchema, NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { EmotionAnalysisInput, EmotionAnalysisResult, EmotionAnalyzer } from "@vicissitude/shared/ports";
import { z } from "zod";

/** 軽量 LLM 呼び出しポート。テキストを送り、応答テキストを受け取る */
export interface LlmPromptPort {
	prompt(text: string): Promise<string>;
}

const ANALYSIS_PROMPT = `Analyze the emotional tone of the following text and return a JSON object with these fields:
- valence: pleasure (+1) to displeasure (-1)
- arousal: high energy (+1) to low energy (-1)
- dominance: dominant (+1) to submissive (-1)
- confidence: how confident you are in this assessment (0 to 1)

Return ONLY the JSON object, no other text.

Text:
`;

const ResponseSchema = z.object({
	valence: z.number(),
	arousal: z.number(),
	dominance: z.number(),
	confidence: z.number().min(0).max(1),
});

const NEUTRAL_RESULT: EmotionAnalysisResult = {
	emotion: NEUTRAL_EMOTION,
	confidence: 0,
};

export class EmotionEstimator implements EmotionAnalyzer {
	constructor(private readonly llm: LlmPromptPort) {}

	async analyze(input: EmotionAnalysisInput): Promise<EmotionAnalysisResult> {
		try {
			const prompt = input.context
				? `${ANALYSIS_PROMPT}${input.text}\n\nContext:\n${input.context}`
				: `${ANALYSIS_PROMPT}${input.text}`;

			const raw = await this.llm.prompt(prompt);
			const json = JSON.parse(raw);
			const parsed = ResponseSchema.parse(json);
			const emotion = EmotionSchema.parse({
				valence: parsed.valence,
				arousal: parsed.arousal,
				dominance: parsed.dominance,
			});

			return { emotion, confidence: parsed.confidence };
		} catch {
			return NEUTRAL_RESULT;
		}
	}
}
