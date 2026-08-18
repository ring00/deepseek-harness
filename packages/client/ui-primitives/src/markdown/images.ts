import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** One Markdown image resolution request bound to a stable rendered owner. */
export interface MarkdownImageRequest {
  /** Destination exactly as parsed from the Markdown source. */
  source: string
  /** Stable identity of the message, record, or card that owns the image. */
  owner: string
}

/** Why an otherwise valid remote image needs explicit confirmation. */
export type MarkdownImageConfirmationReason = 'potential-secret' | 'private-origin'

/** Localized placeholder and confirmation copy supplied by an image-policy resolver. */
export interface MarkdownImageLabels {
  /** Placeholder text when Markdown omits alt text while resolution is pending. */
  loading: string
  /** Placeholder text when Markdown omits alt text and the image cannot load. */
  unavailable: string
  /** Button text when Markdown omits alt text and confirmation is required. */
  confirmation: string
  /** Hover, focus, and assistive description for a suspected-secret URL. */
  potentialSecretDetails: string
  /** Hover, focus, and assistive description for a private or local destination. */
  privateOriginDetails: string
}

/** A browser-loadable remote destination accepted by the active policy. */
export interface RemoteMarkdownImageResolution {
  kind: 'remote'
  /** Original absolute HTTP(S) URL accepted by the policy. */
  url: string
}

/** A valid remote destination that requires a user gesture before loading. */
export interface ConfirmMarkdownImageResolution {
  kind: 'confirmation-required'
  /** Why automatic browser loading was refused. */
  reason: MarkdownImageConfirmationReason
}

/** Verified immutable attachment bytes imported by the active policy. */
export interface AttachmentMarkdownImageResolution {
  kind: 'attachment'
  /** Opaque attachment-store identity. */
  attachmentId: string
  /** Verified raster media type used to create the browser object URL. */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** Complete verified encoded bytes. */
  data: Uint8Array
}

/** A destination refused or unavailable under the active policy. */
export interface BlockedMarkdownImageResolution {
  kind: 'blocked'
}

/** Result returned by a session-bound Markdown image policy. */
export type MarkdownImageResolution =
  | RemoteMarkdownImageResolution
  | AttachmentMarkdownImageResolution
  | ConfirmMarkdownImageResolution
  | BlockedMarkdownImageResolution

/**
 * Resolve one untrusted Markdown image destination.
 * @param request - authored source and stable owner.
 * @param signal - cancellation for the current mounted render.
 * @returns an allowed remote URL, verified local attachment bytes, confirmation request, or refusal.
 */
export interface MarkdownImageResolver {
  (
    request: MarkdownImageRequest,
    signal: AbortSignal,
  ): Promise<MarkdownImageResolution>
  /** Current localized copy; read at render or tooltip-open time. */
  readonly labels?: (() => MarkdownImageLabels) | undefined
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Optional session policy for assistant-authored Markdown images. */
    markdownImageResolver?: MarkdownImageResolver | undefined
  }
}
