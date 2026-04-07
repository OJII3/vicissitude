import { z } from "zod";

export const spotifyTrackSchema = z.object({
	id: z.string(),
	name: z.string(),
	artistName: z.string(),
	artistId: z.string(),
	albumName: z.string(),
	genres: z.array(z.string()),
	popularity: z.number(),
	releaseDate: z.string(),
	albumArtUrl: z.string(),
});

export type SpotifyTrack = z.infer<typeof spotifyTrackSchema>;
