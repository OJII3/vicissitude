import { z } from "zod";

const FXTWITTER_API_BASE = "https://api.fxtwitter.com";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const FxEmbedPhotoSchema = z.object({
	id: z.string(),
	type: z.enum(["photo", "gif"]),
	url: z.string(),
	width: z.number(),
	height: z.number(),
	altText: z.string().optional(),
});

export const FxEmbedVideoSchema = z.object({
	id: z.string(),
	type: z.enum(["video", "gif"]),
	url: z.string(),
	width: z.number(),
	height: z.number(),
	thumbnail_url: z.string().nullable(),
	duration: z.number(),
	_formats: z
		.object({
			container: z.enum(["mp4", "webm", "m3u8"]),
			codec: z.enum(["h264", "hevc", "vp9", "av1"]),
			bitrate: z.number().optional(),
			url: z.string(),
			size: z.number().optional(),
			height: z.number().optional(),
			width: z.number().optional(),
		})
		.array()
		.optional()
		.nullable(),
});

export const FxEmbedExternalMediaSchema = z.object({
	type: z.literal("video"),
	url: z.string(),
	thumbnail_url: z.string().optional(),
	height: z.number().optional(),
	width: z.number().optional(),
});

export const FxEmbedMediaSchema = z.object({
	photos: FxEmbedPhotoSchema.array().optional(),
	videos: FxEmbedVideoSchema.array().optional(),
	external: FxEmbedExternalMediaSchema.optional(),
	all: z.array(FxEmbedPhotoSchema.or(FxEmbedVideoSchema)).optional(),
});

export const FxEmbedUserSchema = z.object({
	type: z.literal("profile"),
	id: z.string(),
	name: z.string(),
	screen_name: z.string(),
	avatar_url: z.string().nullable(),
	banner_url: z.string().nullable(),
	description: z.string(),
	followers: z.number(),
	following: z.number(),
	statuses: z.number(),
	likes: z.number(),
	protected: z.boolean(),
	verified: z.boolean().optional(),
});

export const FxEmbedStatusSchema = z.object({
	type: z.literal("status"),
	id: z.string(),
	url: z.string(),
	text: z.string(),
	created_at: z.string(),
	created_timestamp: z.number(),
	likes: z.number(),
	reposts: z.number(),
	quotes: z.number(),
	replies: z.number(),
	author: FxEmbedUserSchema,
	media: FxEmbedMediaSchema.optional(),
});

export const FxEmbedStatusResponseSchema = z.object({
	code: z.number(),
	status: FxEmbedStatusSchema,
});

export const FxEmbedProfileResponseSchema = z.object({
	code: z.number(),
	message: z.string().optional(),
	user: FxEmbedUserSchema,
	reason: z.enum(["suspended"]).optional(),
});

export type FxEmbedPhoto = z.infer<typeof FxEmbedPhotoSchema>;
export type FxEmbedVideo = z.infer<typeof FxEmbedVideoSchema>;
export type FxEmbedMedia = z.infer<typeof FxEmbedMediaSchema>;
export type FxEmbedUser = z.infer<typeof FxEmbedUserSchema>;
export type FxEmbedStatus = z.infer<typeof FxEmbedStatusSchema>;
export type FxEmbedStatusResponse = z.infer<typeof FxEmbedStatusResponseSchema>;
export type FxEmbedProfileResponse = z.infer<typeof FxEmbedProfileResponseSchema>;

export interface FxEmbedClient {
	getStatus(statusId: string): Promise<FxEmbedStatus | null>;
	getProfile(handle: string): Promise<FxEmbedUser | null>;
}

export interface HttpFxEmbedClientOptions {
	fetchFn?: FetchLike;
	timeoutMs?: number;
}

const TWITTER_URL_RE =
	/https?:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]{1,15})(?:\/status\/(\d{1,20}))?/g;

export interface ParsedTwitterUrl {
	handle: string;
	statusId?: string;
}

export function parseTwitterUrl(url: string): ParsedTwitterUrl | null {
	TWITTER_URL_RE.lastIndex = 0;
	const match = TWITTER_URL_RE.exec(url);
	if (!match) return null;
	const [, handle, statusId] = match;
	if (handle === undefined) return null;
	return {
		handle,
		statusId: statusId ?? undefined,
	};
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpFxEmbedClient implements FxEmbedClient {
	private readonly fetchFn: FetchLike;
	private readonly timeoutMs: number;

	constructor(options: HttpFxEmbedClientOptions = {}) {
		this.fetchFn = options.fetchFn ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async getStatus(statusId: string): Promise<FxEmbedStatus | null> {
		const url = `${FXTWITTER_API_BASE}/2/status/${encodeURIComponent(statusId)}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchFn(url, { signal: controller.signal });
			if (!res.ok) return null;
			const json = await res.json();
			const parsed = FxEmbedStatusResponseSchema.safeParse(json);
			if (!parsed.success) return null;
			return parsed.data.status;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	async getProfile(handle: string): Promise<FxEmbedUser | null> {
		const url = `${FXTWITTER_API_BASE}/2/profile/${encodeURIComponent(handle)}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchFn(url, { signal: controller.signal });
			if (!res.ok) return null;
			const json = await res.json();
			const parsed = FxEmbedProfileResponseSchema.safeParse(json);
			if (!parsed.success) return null;
			return parsed.data.user;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
}
