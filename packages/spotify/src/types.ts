import { z } from "zod";

export const spotifyNonEmptyStringSchema = z.string().trim().min(1);

export const spotifyHttpUrlSchema = z
	.url()
	.trim()
	.refine(
		(value) => {
			try {
				const url = new URL(value);
				return url.protocol === "http:" || url.protocol === "https:";
			} catch {
				return false;
			}
		},
		{ message: "Invalid URL protocol" },
	);

function isValidReleaseDate(value: string): boolean {
	const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
	if (!match) return false;

	const yearText = match[1];
	if (!yearText) return false;
	const year = Number(yearText);
	if (year < 1) return false;

	const monthText = match[2];
	if (!monthText) return true;
	const month = Number(monthText);
	if (month < 1 || month > 12) return false;

	const dayText = match[3];
	if (!dayText) return true;
	const day = Number(dayText);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

export const spotifyReleaseDateSchema = spotifyNonEmptyStringSchema.refine(isValidReleaseDate, {
	message: "Invalid Spotify release date",
});

export const spotifyTrackSchema = z.object({
	id: spotifyNonEmptyStringSchema,
	name: spotifyNonEmptyStringSchema,
	artistName: spotifyNonEmptyStringSchema,
	artistId: spotifyNonEmptyStringSchema,
	albumName: spotifyNonEmptyStringSchema,
	genres: z.array(spotifyNonEmptyStringSchema),
	popularity: z.number().int().min(0).max(100),
	releaseDate: spotifyReleaseDateSchema,
	albumArtUrl: spotifyHttpUrlSchema,
});

export type SpotifyTrack = z.infer<typeof spotifyTrackSchema>;
