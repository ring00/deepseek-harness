// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { MarkdownImageResolver } from '@deepseek-ai/dsh-client-ui-primitives'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('Markdown image browser resolver', () => {
  it('contributes one session-bound resolver and projects remote and attachment responses', async () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('en')
    ctx.provide('locale', locale)
    let descriptor: {
      resolve(binding: { sessionId: string }): { props: { markdownImageResolver: MarkdownImageResolver } }
    } | undefined
    const provide = vi.fn((value: typeof descriptor) => {
      descriptor = value
      return () => {}
    })
    ctx.provide('sessions', { provide } as never)
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { kind: 'remote', url: 'https://cdn.example/image.png' } })
      .mockResolvedValueOnce({
        ok: true,
        value: { kind: 'confirmation-required', reason: 'potential-secret' },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          kind: 'attachment',
          attachment: {
            attachmentId: 'sha256:test', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
          },
          data: Buffer.from([1, 2, 3]).toString('base64'),
        },
      })
    ctx.reflect.provide('connection', { rpc: { call } })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(provide).toHaveBeenCalledOnce()
    if (descriptor === undefined) throw new Error('resolver contribution missing')
    const resolver = descriptor.resolve({ sessionId: 'session-one' }).props.markdownImageResolver
    const signal = new AbortController().signal

    expect(resolver.labels?.()).toEqual({
      loading: 'Loading image',
      unavailable: 'Image unavailable',
      confirmation: 'Image requires confirmation',
      potentialSecretDetails: 'This image URL may contain sensitive information. Activate to load it exactly as written.',
      privateOriginDetails: 'This image points to a local or private network address. Activate to load it exactly as written.',
    })

    await expect(resolver({ source: 'https://cdn.example/image.png', owner: 'assistant:1' }, signal))
      .resolves.toEqual({ kind: 'remote', url: 'https://cdn.example/image.png' })
    await expect(resolver({ source: 'https://cdn.example/suspicious.png', owner: 'assistant:1' }, signal))
      .resolves.toEqual({ kind: 'confirmation-required', reason: 'potential-secret' })
    await expect(resolver({ source: './local.png', owner: 'assistant:1' }, signal))
      .resolves.toEqual({
        kind: 'attachment',
        attachmentId: 'sha256:test',
        mediaType: 'image/png',
        data: Uint8Array.of(1, 2, 3),
      })
    expect(call).toHaveBeenNthCalledWith(1, '/markdown-images', 'resolve', {
      sessionId: 'session-one',
      source: 'https://cdn.example/image.png',
      owner: 'assistant:1',
    }, signal)
    await fiber.dispose()
  })

  it('fails closed on Host errors and malformed responses while forwarding cancellation', async () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('en')
    ctx.provide('locale', locale)
    let resolver: MarkdownImageResolver | undefined
    ctx.provide('sessions', {
      provide: (descriptor: {
        resolve(binding: { sessionId: string }): { props: { markdownImageResolver: MarkdownImageResolver } }
      }) => {
        resolver = descriptor.resolve({ sessionId: 'session-errors' }).props.markdownImageResolver
        return () => {}
      },
    } as never)
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'failed', details: {} } })
      .mockResolvedValueOnce({ ok: true, value: { kind: 'remote', url: 42 } })
    ctx.reflect.provide('connection', { rpc: { call } })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    if (resolver === undefined) throw new Error('resolver contribution missing')
    const controller = new AbortController()

    await expect(resolver({ source: 'https://example.com/one', owner: 'one' }, controller.signal))
      .resolves.toEqual({ kind: 'blocked' })
    await expect(resolver({ source: 'https://example.com/two', owner: 'two' }, controller.signal))
      .resolves.toEqual({ kind: 'blocked' })
    expect(call.mock.calls.every((args: unknown[]) => args[3] === controller.signal)).toBe(true)
    await fiber.dispose()
  })
})
