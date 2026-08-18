import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { LocalMarkdownImageImporter } from '../src/importer.ts'

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

interface Bench {
  importer: LocalMarkdownImageImporter
  fileData: { value: Uint8Array }
  available: { value: boolean }
  resolvePath: ReturnType<typeof vi.fn>
  readBytes: ReturnType<typeof vi.fn>
  saveImage: Mock<(input: SaveImageAttachment) => Promise<ImageAttachmentRef>>
  readImage: ReturnType<typeof vi.fn>
  stored: { ref?: ImageAttachmentRef; data?: Uint8Array }
}

const roots: string[] = []
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-markdown-images-'))
  roots.push(home)
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function bench(): Bench {
  const ctx = new Context()
  const fileData = { value: PNG }
  const available = { value: true }
  const stored: { ref?: ImageAttachmentRef; data?: Uint8Array } = {}
  const resolvePath = vi.fn(async (path: string, options?: { cwd?: string }) => ({
    targetKey: `${options?.cwd ?? ''}\0${path}`,
  }))
  const readBytes = vi.fn(async () => new Uint8Array(fileData.value))
  const fs = {
    resolve: resolvePath,
    stat: vi.fn(async () => available.value ? { type: 'file' } : undefined),
    readBytes,
  } as unknown as FileSystem
  const saveImage = vi.fn(async (input: SaveImageAttachment) => {
    const digest = createHash('sha256').update(input.data).digest('hex')
    const ref: ImageAttachmentRef = {
      attachmentId: `sha256:${digest}` as never,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
    stored.ref = ref
    stored.data = new Uint8Array(input.data)
    return ref
  })
  const readImage = vi.fn(async (ref: ImageAttachmentRef) => {
    if (stored.ref === undefined || stored.data === undefined) throw new Error('attachment missing')
    return { ref, data: new Uint8Array(stored.data) }
  })
  const attachments = {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 2048,
      maxImagePixels: 16,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    saveImage,
    readImage,
  } as unknown as AttachmentStore
  ctx.provide('fs', fs)
  ctx.provide('attachments', attachments)
  return {
    importer: new LocalMarkdownImageImporter(ctx),
    fileData, available, resolvePath, readBytes, saveImage, readImage, stored,
  }
}

function decodedData(value: Awaited<ReturnType<LocalMarkdownImageImporter['resolve']>>): Uint8Array | undefined {
  return value.kind === 'attachment' ? Uint8Array.from(Buffer.from(value.data, 'base64')) : undefined
}

function mappingPath(home: string, session: string, owner: string, source: string): string {
  const key = createHash('sha256').update(session).update('\0').update(owner).update('\0').update(source).digest('hex')
  return join(home, 'markdown-images', 'v1', 'mappings', key.slice(0, 2), `${key}.json`)
}

describe('local Markdown image importer', { concurrent: false }, () => {
  it('resolves relative, absolute, Windows, and file URL sources through ctx.fs', async () => {
    const test = bench()
    const cases = [
      { source: 'images/pixel.png', expected: 'images/pixel.png', cwd: '/workspace' },
      { source: '/tmp/pixel.png', expected: '/tmp/pixel.png', cwd: undefined },
      { source: String.raw`C:\work\pixel.png`, expected: String.raw`C:\work\pixel.png`, cwd: undefined },
      { source: pathToFileURL('/tmp/file pixel.png').href, expected: '/tmp/file pixel.png', cwd: undefined },
    ]
    for (const [index, item] of cases.entries()) {
      const result = await test.importer.resolve(
        SessionId('session-paths'), `owner-${index}`, item.source, item.cwd,
      )
      expect(result.kind).toBe('attachment')
      expect(test.resolvePath).toHaveBeenLastCalledWith(
        item.expected,
        item.cwd === undefined ? undefined : { cwd: item.cwd },
      )
    }
  })

  it('deduplicates concurrent imports and stores no plaintext source in the mapping', async () => {
    const test = bench()
    let release: (() => void) | undefined
    test.saveImage.mockImplementationOnce(async (input: SaveImageAttachment) => {
      await new Promise<void>((resolvePromise) => { release = resolvePromise })
      const ref: ImageAttachmentRef = {
        attachmentId: 'sha256:concurrent' as never,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
      }
      test.stored.ref = ref
      test.stored.data = new Uint8Array(input.data)
      return ref
    })
    const source = 'private/folder/secret-name.png'
    const first = test.importer.resolve(SessionId('session-one'), 'assistant:one', source, '/workspace')
    const second = test.importer.resolve(SessionId('session-one'), 'assistant:one', source, '/workspace')
    expect(first).toBe(second)
    await vi.waitFor(() => { expect(test.saveImage).toHaveBeenCalledOnce() })
    release?.()
    await expect(first).resolves.toMatchObject({ kind: 'attachment' })
    await expect(second).resolves.toMatchObject({ kind: 'attachment' })
    expect(test.readBytes).toHaveBeenCalledOnce()

    const file = mappingPath(process.env.DSH_HOME as string, 'session-one', 'assistant:one', source)
    const mapping = await readFile(file, 'utf8')
    expect(mapping).not.toContain(source)
    expect(mapping).toContain('sha256:concurrent')
  })

  it('replays the original attachment after the source changes or disappears', async () => {
    const test = bench()
    const original = await test.importer.resolve(
      SessionId('session-replay'), 'assistant:one', './pixel.png', '/workspace',
    )
    test.fileData.value = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9)
    test.available.value = false
    const replay = await test.importer.resolve(
      SessionId('session-replay'), 'assistant:one', './pixel.png', '/workspace',
    )

    expect(decodedData(original)).toEqual(PNG)
    expect(decodedData(replay)).toEqual(PNG)
    expect(test.saveImage).toHaveBeenCalledOnce()
    expect(test.readBytes).toHaveBeenCalledOnce()
    expect(test.readImage).toHaveBeenCalledOnce()
  })

  it('fails visibly when a cached attachment is missing instead of importing newer bytes', async () => {
    const test = bench()
    await test.importer.resolve(SessionId('session-missing'), 'assistant:one', './pixel.png', '/workspace')
    test.fileData.value = Uint8Array.of(...PNG, 1)
    test.readImage.mockRejectedValueOnce(new Error('attachment missing'))

    await expect(test.importer.resolve(
      SessionId('session-missing'), 'assistant:one', './pixel.png', '/workspace',
    )).resolves.toEqual({ kind: 'blocked' })
    expect(test.saveImage).toHaveBeenCalledOnce()
    expect(test.readBytes).toHaveBeenCalledOnce()
  })

  it('blocks unsupported bytes, provider denial, absent files, and attachment admission failures', async () => {
    const test = bench()
    test.fileData.value = Uint8Array.of(1, 2, 3)
    await expect(test.importer.resolve(
      SessionId('session-invalid'), 'owner-invalid', './invalid.svg', '/workspace',
    )).resolves.toEqual({ kind: 'blocked' })
    expect(test.saveImage).not.toHaveBeenCalled()

    test.fileData.value = PNG
    test.resolvePath.mockRejectedValueOnce(new Error('provider denied read'))
    await expect(test.importer.resolve(
      SessionId('session-denied'), 'owner-denied', './denied.png', '/workspace',
    )).resolves.toEqual({ kind: 'blocked' })

    test.available.value = false
    await expect(test.importer.resolve(
      SessionId('session-absent'), 'owner-absent', './absent.png', '/workspace',
    )).resolves.toEqual({ kind: 'blocked' })

    test.available.value = true
    test.saveImage.mockRejectedValueOnce(new Error('attachment pixel limit'))
    await expect(test.importer.resolve(
      SessionId('session-limit'), 'owner-limit', './large.png', '/workspace',
    )).resolves.toEqual({ kind: 'blocked' })
  })

  it('keeps a corrupt mapping terminal for that owner and source', async () => {
    const test = bench()
    const session = 'session-corrupt'
    const owner = 'assistant:one'
    const source = './pixel.png'
    await test.importer.resolve(SessionId(session), owner, source, '/workspace')
    const file = mappingPath(process.env.DSH_HOME as string, session, owner, source)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '{not-json}\n')
    test.fileData.value = Uint8Array.of(...PNG, 1)

    await expect(test.importer.resolve(
      SessionId(session), owner, source, '/workspace',
    )).resolves.toEqual({ kind: 'blocked' })
    expect(test.saveImage).toHaveBeenCalledOnce()
    expect(test.readBytes).toHaveBeenCalledOnce()
  })
})
