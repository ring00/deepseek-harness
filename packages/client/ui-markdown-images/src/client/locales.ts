/** `markdownImages` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  loading: '图片加载中',
  unavailable: '图片不可用',
  confirmation: '图片需要确认',
  potentialSecretDetails: '此图片地址可能包含敏感信息。激活后将按原样加载该地址。',
  privateOriginDetails: '此图片指向本地或专用网络地址。激活后将按原样加载该地址。',
} satisfies Record<string, string>

/** The Markdown image namespace key union. */
export type MarkdownImagesKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  loading: 'Loading image',
  unavailable: 'Image unavailable',
  confirmation: 'Image requires confirmation',
  potentialSecretDetails: 'This image URL may contain sensitive information. Activate to load it exactly as written.',
  privateOriginDetails: 'This image points to a local or private network address. Activate to load it exactly as written.',
} satisfies Record<MarkdownImagesKey, string>
