/** Browser-safe request and response vocabulary for Markdown image resolution. */

import { z } from 'zod'

/** Maximum authored destination length admitted by the wire contract. */
export const MAX_MARKDOWN_IMAGE_SOURCE_LENGTH = 16 * 1024
/** Maximum stable owner length admitted by the wire contract. */
export const MAX_MARKDOWN_IMAGE_OWNER_LENGTH = 512

const imageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Host request for one image in one stable session rendering owner. */
export interface MarkdownImageResolveRequest {
  sessionId: string
  source: string
  owner: string
}

/** Wire response for an allowed browser-fetched image. */
export interface RemoteMarkdownImageWireResolution {
  kind: 'remote'
  url: string
}

/** Wire response for a verified immutable attachment. */
export interface AttachmentMarkdownImageWireResolution {
  kind: 'attachment'
  attachment: {
    attachmentId: string
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    bytes: number
    width: number
    height: number
    name?: string | undefined
  }
  data: string
}

/** Wire response for a refused or unavailable image. */
export interface BlockedMarkdownImageWireResolution {
  kind: 'blocked'
}

/** Wire response requiring a user gesture before browser loading. */
export interface ConfirmMarkdownImageWireResolution {
  kind: 'confirmation-required'
  reason: 'potential-secret' | 'private-origin'
}

/** Complete Host response union. */
export type MarkdownImageWireResolution =
  | RemoteMarkdownImageWireResolution
  | AttachmentMarkdownImageWireResolution
  | ConfirmMarkdownImageWireResolution
  | BlockedMarkdownImageWireResolution

/** Runtime request parser shared by the Host handler and its tests. */
export const markdownImageResolveRequestSchema = z.object({
  sessionId: z.string().min(1).max(512),
  source: z.string().max(MAX_MARKDOWN_IMAGE_SOURCE_LENGTH),
  owner: z.string().min(1).max(MAX_MARKDOWN_IMAGE_OWNER_LENGTH),
}).strict()

/** Runtime response parser shared by the browser resolver and its tests. */
export const markdownImageWireResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote'), url: z.string() }).strict(),
  z.object({
    kind: z.literal('attachment'),
    attachment: z.object({
      attachmentId: z.string().min(1),
      mediaType: imageMediaTypeSchema,
      bytes: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      name: z.string().optional(),
    }).strict(),
    data: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('confirmation-required'),
    reason: z.enum(['potential-secret', 'private-origin']),
  }).strict(),
  z.object({ kind: z.literal('blocked') }).strict(),
])
