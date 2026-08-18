/** Persistent local Markdown image import into the deployment AttachmentStore. */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AttachmentMarkdownImageWireResolution, BlockedMarkdownImageWireResolution } from './contract.ts'

const EXPLICIT_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/
const BLOCKED: BlockedMarkdownImageWireResolution = Object.freeze({ kind: 'blocked' })

interface MappingRecord {
  version: 1
  attachment: ImageAttachmentRef
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function localPath(source: string): string | undefined {
  if (source.toLowerCase().startsWith('file:')) {
    try {
      const url = new URL(source)
      if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost')) return undefined
      return fileURLToPath(url)
    } catch {
      return undefined
    }
  }
  if (EXPLICIT_SCHEME.test(source) && !win32.isAbsolute(source)) return undefined
  return source
}

function detectMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const header = String.fromCharCode(...data.subarray(0, 6))
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

function parseMapping(value: unknown): MappingRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.attachment === null || typeof record.attachment !== 'object') return undefined
  const ref = record.attachment as Record<string, unknown>
  if (typeof ref.attachmentId !== 'string'
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(ref.mediaType))
    || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
    || typeof ref.width !== 'number' || !Number.isSafeInteger(ref.width) || ref.width < 1
    || typeof ref.height !== 'number' || !Number.isSafeInteger(ref.height) || ref.height < 1
    || (ref.name !== undefined && typeof ref.name !== 'string')) return undefined
  return {
    version: 1,
    attachment: {
      attachmentId: AttachmentId(ref.attachmentId),
      mediaType: ref.mediaType as ImageMediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    },
  }
}

function attachmentWire(
  attachment: ImageAttachmentRef,
  data: Uint8Array,
): AttachmentMarkdownImageWireResolution {
  return { kind: 'attachment', attachment, data: Buffer.from(data).toString('base64') }
}

/** Imports and replays local Markdown image sources through mounted services. */
export class LocalMarkdownImageImporter {
  private readonly root = resolve(join(resolveDshHome(), 'markdown-images', 'v1', 'mappings'))
  private readonly pending = new Map<string, Promise<AttachmentMarkdownImageWireResolution | BlockedMarkdownImageWireResolution>>()

  constructor(private readonly ctx: Context) {}

  /**
   * Resolve one local source to an immutable attachment snapshot.
   * @param sessionId - owning session identity.
   * @param owner - stable rendering owner.
   * @param source - authored local source.
   * @param cwd - immutable session working directory.
   * @returns verified attachment bytes, or refusal.
   */
  resolve(
    sessionId: SessionId,
    owner: string,
    source: string,
    cwd: string | undefined,
  ): Promise<AttachmentMarkdownImageWireResolution | BlockedMarkdownImageWireResolution> {
    const path = localPath(source)
    if (path === undefined) return Promise.resolve(BLOCKED)
    const key = createHash('sha256').update(sessionId).update('\0').update(owner).update('\0').update(source).digest('hex')
    const active = this.pending.get(key)
    if (active !== undefined) return active
    const operation = this.resolveKey(key, path, cwd).catch(() => BLOCKED)
    this.pending.set(key, operation)
    void operation.finally(() => {
      if (this.pending.get(key) === operation) this.pending.delete(key)
    })
    return operation
  }

  private async resolveKey(
    key: string,
    path: string,
    cwd: string | undefined,
  ): Promise<AttachmentMarkdownImageWireResolution | BlockedMarkdownImageWireResolution> {
    const mappingPath = join(this.root, key.slice(0, 2), `${key}.json`)
    await mkdir(join(this.root, key.slice(0, 2)), { recursive: true, mode: 0o700 })
    return withFileLock(mappingPath, async () => {
      let serialized: string | undefined
      try {
        serialized = await readFile(mappingPath, 'utf8')
      } catch (error) {
        if (!isEnoent(error)) throw error
      }
      if (serialized !== undefined) {
        let mapping: MappingRecord | undefined
        try {
          mapping = parseMapping(JSON.parse(serialized))
        } catch {
          return BLOCKED
        }
        if (mapping === undefined) return BLOCKED
        try {
          const stored = await this.ctx.attachments.readImage(mapping.attachment)
          return attachmentWire(stored.ref, stored.data)
        } catch {
          return BLOCKED
        }
      }

      const target = await this.ctx.fs.resolve(path, cwd === undefined ? undefined : { cwd })
      const info = await this.ctx.fs.stat(target)
      if (info?.type !== 'file') return BLOCKED
      const data = await this.ctx.fs.readBytes(target, undefined, this.ctx.attachments.imageLimits.maxImageBytes)
      const mediaType = detectMediaType(data)
      if (mediaType === undefined) return BLOCKED
      const attachment = await this.ctx.attachments.saveImage({ data, mediaType })
      await writeFileAtomic(
        mappingPath,
        `${JSON.stringify({ version: 1, attachment } satisfies MappingRecord)}\n`,
        { mode: 0o600, dirMode: 0o700 },
      )
      return attachmentWire(attachment, data)
    })
  }
}
