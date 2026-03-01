/**
 * セッションキーの値オブジェクト。
 * プラットフォーム・チャンネル・ユーザーを一意に識別する。
 */
export type SessionKey = `${string}:${string}:${string}`;

export function createSessionKey(platform: string, channelId: string, userId: string): SessionKey {
	return `${platform}:${channelId}:${userId}`;
}

/**
 * ホームチャンネル用のチャンネル単位セッションキー。
 * 全員の会話を共有セッションで管理する。
 */
export function createChannelSessionKey(platform: string, channelId: string): SessionKey {
	return `${platform}:${channelId}:_channel`;
}
