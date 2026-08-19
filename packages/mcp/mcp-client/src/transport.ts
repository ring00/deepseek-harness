/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Create a fetch implementation that follows redirects while retaining
 * plugin-configured headers only for the configured origin.
 * @param configuredUrl - MCP endpoint whose origin is authorized to receive the headers.
 * @param configuredHeaders - fixed headers supplied by the plugin configuration.
 * @param fetchImpl - underlying fetch implementation.
 * @returns fetch implementation suitable for the MCP SDK transport.
 */
export function originScopedFetch(
  configuredUrl: URL,
  configuredHeaders: Readonly<Record<string, string>>,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  const configuredOrigin = configuredUrl.origin
  const configuredNames = new Set(Object.keys(configuredHeaders).map(name => name.toLowerCase()))
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    let url = new URL(input instanceof Request ? input.url : String(input), configuredUrl)
    let method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    let body = init?.body
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => { headers.set(key, value) })

    for (let redirects = 0; ; redirects += 1) {
      const requestHeaders = new Headers(headers)
      if (url.origin !== configuredOrigin) {
        for (const name of configuredNames) requestHeaders.delete(name)
      }
      const response = await fetchImpl(url, {
        ...init,
        method,
        body: body ?? null,
        headers: requestHeaders,
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || location === null) return response
      if (redirects >= MAX_REDIRECTS) throw new TypeError(`MCP HTTP request exceeded ${MAX_REDIRECTS} redirects`)

      url = new URL(location, url)
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method.toUpperCase() === 'POST')) {
        method = 'GET'
        body = undefined
        headers.delete('content-length')
        headers.delete('content-type')
      }
    }
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      // The MCP SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening.
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          fetch: originScopedFetch(new URL(config.url), config.headers),
        },
      ) as Transport
  }
}
