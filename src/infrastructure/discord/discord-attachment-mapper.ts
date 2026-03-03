import type { Attachment as DiscordAttachment, Collection } from "discord.js";

import type { Attachment } from "../../domain/entities/attachment.ts";

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function mapAttachments(attachments: Collection<string, DiscordAttachment>): Attachment[] {
	return attachments
		.filter((a) => a.contentType !== null && ALLOWED_IMAGE_MIME_TYPES.has(a.contentType))
		.map((a) => ({
			url: a.url,
			contentType: a.contentType ?? undefined,
			filename: a.name ?? undefined,
		}));
}

export function filterImageUrls(attachments: Collection<string, DiscordAttachment>): string[] {
	return attachments
		.filter((a) => a.contentType !== null && ALLOWED_IMAGE_MIME_TYPES.has(a.contentType))
		.map((a) => a.url);
}
