/** Host half of the session-scoped Markdown image policy plugin. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-fs'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  markdownImageResolveRequestSchema,
  type MarkdownImageWireResolution,
} from './contract.ts'
import { LocalMarkdownImageImporter } from './importer.ts'
import { normalizeTrustedOrigins, resolveRemoteImage } from './policy.ts'

export type {
  AttachmentMarkdownImageWireResolution, BlockedMarkdownImageWireResolution,
  ConfirmMarkdownImageWireResolution, MarkdownImageResolveRequest,
  MarkdownImageWireResolution, RemoteMarkdownImageWireResolution,
} from './contract.ts'
export {
  inspectRemoteImageUrl, isLocalImageHostname, normalizeTrustedOrigins, resolveRemoteImage,
} from './policy.ts'
export type { RemoteImageDecision, RemoteImageInspection } from './policy.ts'

/** Stable Cordis plugin name. */
export const name = 'client-ui-markdown-images'
/** Host services required by policy resolution and local imports. */
export const inject = ['connection', 'sessions', 'fs', 'attachments']

/** Deployment-owned Markdown image policy configuration. */
export interface Config {
  /** Exact private HTTP(S) origins allowed to load automatically. */
  trustedOrigins?: string[]
}

/** Plugin configuration schema. */
export const Config: z<Config> = z.object({
  trustedOrigins: z.array(String).default([]),
})

function badRequest(message: string, issues: unknown[]): RpcResult<MarkdownImageWireResolution> {
  return {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: issues as never[] } },
  }
}

/**
 * Register the trusted Host RPC image resolver.
 * @param ctx - Host context with session, filesystem, attachment, and transport services.
 * @param config - exact trusted-origin exceptions.
 */
export function apply(ctx: Context, config?: Config): void {
  const trustedOrigins = normalizeTrustedOrigins(config?.trustedOrigins ?? [])
  const importer = new LocalMarkdownImageImporter(ctx)
  ctx.effect(() => ctx.connection.rpc.handle('/markdown-images', async (endpoint, payload) => {
    if (endpoint !== 'resolve') return badRequest(`unknown markdown-images endpoint: ${endpoint}`, [])
    const parsed = markdownImageResolveRequestSchema.safeParse(payload)
    if (!parsed.success) return badRequest('invalid markdown image request', parsed.error.issues)
    const request = parsed.data
    const sessionId = SessionId(request.sessionId)
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      return {
        ok: false,
        error: {
          code: 'session-not-found',
          message: `session not found: ${request.sessionId}`,
          details: { sessionId },
        },
      }
    }
    const remote = resolveRemoteImage(request.source, trustedOrigins)
    if (remote !== undefined) return { ok: true, value: remote }
    const value = await importer.resolve(sessionId, request.owner, request.source, session.header.cwd)
    return { ok: true, value }
  }, { authority: 'trusted-host' }), 'client-ui-markdown-images: resolver channel')
}
