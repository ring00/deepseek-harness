/** Browser half: contribute one bound Markdown image resolver to every session. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  MarkdownImageLabels, MarkdownImageResolution, MarkdownImageResolver,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import {
  markdownImageWireResolutionSchema,
  type MarkdownImageWireResolution,
} from '../contract.ts'
import { en, zh, type MarkdownImagesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Markdown image policy placeholder and confirmation copy. */
    markdownImages: MarkdownImagesKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'markdownImages'

/** Required browser services. */
export const inject = ['connection', 'sessions', 'locale']

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const data = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index)
  return data
}

function toResolution(value: MarkdownImageWireResolution): MarkdownImageResolution {
  if (value.kind !== 'attachment') return value
  return {
    kind: 'attachment',
    attachmentId: value.attachment.attachmentId,
    mediaType: value.attachment.mediaType,
    data: decodeBase64(value.data),
  }
}

/**
 * Register the session-standard resolver contribution.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('client-ui-markdown-images: connection service is unavailable')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-markdown-images: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sessions.provide({
    props: ['markdownImageResolver'],
    resolve: (binding) => {
      const resolve = async (
        request: Parameters<MarkdownImageResolver>[0],
        signal: AbortSignal,
      ): Promise<MarkdownImageResolution> => {
        const result = await connection.rpc.call('/markdown-images', 'resolve', {
          sessionId: binding.sessionId,
          ...request,
        }, signal)
        if (!result.ok) return { kind: 'blocked' }
        const parsed = markdownImageWireResolutionSchema.safeParse(result.value)
        return parsed.success ? toResolution(parsed.data) : { kind: 'blocked' }
      }
      const resolver: MarkdownImageResolver = Object.assign(resolve, {
        labels: (): MarkdownImageLabels => ({
          loading: t('loading'),
          unavailable: t('unavailable'),
          confirmation: t('confirmation'),
          potentialSecretDetails: t('potentialSecretDetails'),
          privateOriginDetails: t('privateOriginDetails'),
        }),
      })
      return { props: { markdownImageResolver: resolver } }
    },
  }), 'client-ui-markdown-images: session resolver')
}
