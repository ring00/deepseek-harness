import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { originScopedFetch } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })))
})

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('origin-scoped MCP headers', () => {
  it('accepts Request inputs and preserves their method and headers', async () => {
    let observedMethod: string | undefined
    let observedHeader: string | undefined
    const origin = await listen((request, response) => {
      observedMethod = request.method
      observedHeader = request.headers['x-request-header'] as string | undefined
      response.writeHead(204).end()
    })
    const scopedFetch = originScopedFetch(new URL(`${origin}/mcp`), { 'X-Request-Header': 'request-value' })

    await scopedFetch(new Request(`${origin}/mcp`, {
      method: 'PUT',
      headers: { 'X-Request-Header': 'request-value' },
    }))

    expect(observedMethod).toBe('PUT')
    expect(observedHeader).toBe('request-value')
  })

  it('retains configured headers across a same-origin redirect', async () => {
    let observed: string | undefined
    const origin = await listen((request, response) => {
      if (request.url === '/start') {
        response.writeHead(307, { location: '/target' }).end()
        return
      }
      observed = request.headers['x-plugin-header'] as string | undefined
      response.writeHead(204).end()
    })

    const scopedFetch = originScopedFetch(new URL(`${origin}/start`), { 'X-Plugin-Header': 'same-origin' })
    await scopedFetch(`${origin}/start`, { headers: { 'X-Plugin-Header': 'same-origin' } })

    expect(observed).toBe('same-origin')
  })

  it('rewrites redirected POST to GET and removes body headers', async () => {
    let observedMethod: string | undefined
    let observedLength: string | undefined
    let observedType: string | undefined
    const origin = await listen((request, response) => {
      if (request.url === '/start') {
        response.writeHead(303, { location: '/target' }).end()
        return
      }
      observedMethod = request.method
      observedLength = request.headers['content-length']
      observedType = request.headers['content-type']
      response.writeHead(204).end()
    })
    const scopedFetch = originScopedFetch(new URL(`${origin}/start`), {})

    await scopedFetch(`${origin}/start`, {
      method: 'POST',
      body: 'payload',
      headers: { 'Content-Length': '7', 'Content-Type': 'text/plain' },
    })

    expect(observedMethod).toBe('GET')
    expect(observedLength).toBeUndefined()
    expect(observedType).toBeUndefined()
  })

  it('rejects a redirect chain beyond the fetch-compatible limit', async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(302, { location: '/again' }).end()
    })
    const scopedFetch = originScopedFetch(new URL(`${origin}/start`), {})

    await expect(scopedFetch(`${origin}/start`)).rejects.toThrow('exceeded 20 redirects')
  })

  it('removes every configured header before a cross-origin redirect', async () => {
    let observedPluginHeader: string | undefined
    let observedAuthorization: string | undefined
    const target = await listen((request, response) => {
      observedPluginHeader = request.headers['x-plugin-header'] as string | undefined
      observedAuthorization = request.headers.authorization
      response.writeHead(204).end()
    })
    const source = await listen((_request, response) => {
      response.writeHead(307, { location: `${target}/target` }).end()
    })
    const configuredHeaders = {
      Authorization: 'Bearer plugin-secret',
      'X-Plugin-Header': 'plugin-value',
    }
    const scopedFetch = originScopedFetch(new URL(`${source}/start`), configuredHeaders)
    await scopedFetch(`${source}/start`, { headers: configuredHeaders })

    expect(observedPluginHeader).toBeUndefined()
    expect(observedAuthorization).toBeUndefined()
  })
})
