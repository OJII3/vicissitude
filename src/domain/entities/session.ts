/**
 * セッションキーの値オブジェクト。
 * プラットフォーム・チャンネル・ユーザーを一意に識別する。
 */
export type SessionKey = `${string}:${string}:${string}`;

export function createSessionKey(
	platform: string,
	channelId: string,
	userId: string,
): SessionKey {
	return `${platform}:${channelId}:${userId}`;
}
