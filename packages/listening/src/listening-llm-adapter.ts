import type { MemoryLlmPort, Schema } from "@vicissitude/memory/llm-port";
import type { ChatMessage } from "@vicissitude/memory/types";

import type {
	ImpressionInput,
	TrackLlmInput,
	TrackLlmPort,
	TrackUnderstanding,
	VocalGender,
} from "./types.ts";

const VOCAL_GENDERS: readonly VocalGender[] = ["male", "female", "mixed", "unknown"];

const understandingSchema: Schema<TrackUnderstanding> = {
	parse: (data: unknown): TrackUnderstanding => {
		if (typeof data !== "object" || data === null) {
			throw new TypeError("understanding response is not an object");
		}
		const d = data as Record<string, unknown>;
		const vocalGender =
			typeof d.vocalGender === "string" &&
			(VOCAL_GENDERS as readonly string[]).includes(d.vocalGender)
				? (d.vocalGender as VocalGender)
				: "unknown";
		const tieIn = typeof d.tieIn === "string" && d.tieIn.length > 0 ? d.tieIn : null;
		const moodThemes = Array.isArray(d.moodThemes)
			? d.moodThemes.filter((x): x is string => typeof x === "string")
			: [];
		const summary = typeof d.summary === "string" ? d.summary : "";
		return { vocalGender, tieIn, moodThemes, summary };
	},
};

const impressionSchema: Schema<string> = {
	parse: (data: unknown): string => {
		if (typeof data !== "object" || data === null) {
			throw new TypeError("impression response is not an object");
		}
		const d = data as Record<string, unknown>;
		if (typeof d.impression !== "string") {
			throw new TypeError("impression field is missing");
		}
		return d.impression;
	},
};

function renderTrackContext(input: TrackLlmInput): string {
	return [
		`Title: ${input.title}`,
		`Artist: ${input.artistName}`,
		`Album: ${input.albumName}`,
		`Genres: ${input.genres.join(", ") || "(unknown)"}`,
		`Release: ${input.releaseDate}`,
		`Lyrics:\n${input.lyrics ?? "(歌詞は取得できなかった)"}`,
	].join("\n");
}

export class ListeningLlmAdapter implements TrackLlmPort {
	constructor(private readonly llm: MemoryLlmPort) {}

	inferUnderstanding(input: TrackLlmInput): Promise<TrackUnderstanding> {
		const messages: ChatMessage[] = [
			{
				role: "system",
				content:
					"あなたは音楽評論家です。楽曲情報から vocalGender(male/female/mixed/unknown)、tieIn(アニメ・映画等のタイアップ、無ければ null)、moodThemes(雰囲気タグ配列)、summary(簡潔な要約) を JSON で返してください。",
			},
			{ role: "user", content: renderTrackContext(input) },
		];
		return this.llm.chatStructured(messages, understandingSchema);
	}

	generateImpression(input: ImpressionInput): Promise<string> {
		const messages: ChatMessage[] = [
			{
				role: "system",
				content:
					"あなたは一人の音楽リスナー『ふあ』です。提供された楽曲を聴いた個人的な感想を 1〜3 文の日本語で述べてください。JSON で {\"impression\": string} を返してください。",
			},
			{
				role: "user",
				content: `${renderTrackContext(input)}\n\nUnderstanding: ${JSON.stringify(input.understanding)}`,
			},
		];
		return this.llm.chatStructured(messages, impressionSchema);
	}

	embed(text: string): Promise<number[]> {
		return this.llm.embed(text);
	}
}
