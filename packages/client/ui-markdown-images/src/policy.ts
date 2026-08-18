/** Pure remote Markdown image URL inspection and trusted-origin resolution. */

import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { scan } from '@sanity-labs/secret-scan'

/** URL-only inspection result before deployment-owned origin exceptions. */
export type RemoteImageInspection =
  | { kind: 'local-source' }
  | { kind: 'allowed' }
  | { kind: 'confirmation-required'; reason: 'potential-secret' | 'private-origin'; origin: string }
  | { kind: 'blocked' }

/** Remote policy outcome; undefined delegates the source to local importing. */
export type RemoteImageDecision =
  | { kind: 'remote'; url: string }
  | { kind: 'confirmation-required'; reason: 'potential-secret' | 'private-origin' }
  | { kind: 'blocked' }
  | undefined

const EXPLICIT_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

/**
 * Validate and normalize exact trusted origins.
 * @param entries - deployment-authored origin strings.
 * @returns canonical origins used for exact comparisons.
 */
export function normalizeTrustedOrigins(entries: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const entry of entries) {
    let url: URL
    try {
      url = new URL(entry)
    } catch {
      throw new Error(`markdown-images trustedOrigins entry is not an absolute URL: ${entry}`)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error(`markdown-images trustedOrigins entry must be an exact HTTP(S) origin: ${entry}`)
    }
    origins.add(url.origin)
  }
  return origins
}

function ipv4Private(hostname: string): boolean {
  const parts = hostname.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224
}

function ipv6Private(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const lower = bare.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/u.test(lower) || /^fe[89abcdef][0-9a-f]:/u.test(lower)
    || /^ff[0-9a-f]{2}:/u.test(lower)) return true
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1]
  if (mapped !== undefined) return ipv4Private(mapped)
  const canonicalMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u)
  if (canonicalMapped === null) return false
  const high = Number.parseInt(canonicalMapped[1] ?? '', 16)
  const low = Number.parseInt(canonicalMapped[2] ?? '', 16)
  return ipv4Private(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`)
}

/**
 * Classify local names and literal non-public destinations without DNS.
 * @param hostname - URL hostname, optionally bracketed when it is IPv6.
 * @returns whether the hostname requires an explicit user gesture.
 */
export function isLocalImageHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '')
  const ipVersion = isIP(normalized.startsWith('[') ? normalized.slice(1, -1) : normalized)
  if (ipVersion === 4) return ipv4Private(normalized)
  if (ipVersion === 6) return ipv6Private(normalized)
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || !normalized.includes('.')
}

function decodedOnce(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function containsPotentialSecret(url: URL): boolean {
  const requestUrl = new URL(url.href)
  requestUrl.hash = ''
  const candidates = new Set<string>([
    requestUrl.href,
    decodedOnce(requestUrl.pathname),
  ])
  for (const [key, value] of requestUrl.searchParams) {
    candidates.add(key)
    candidates.add(value)
  }
  return [...candidates].some(candidate => scan(candidate).length > 0)
}

function assertNever(_value: never): never {
  throw new Error('unexpected Markdown image inspection result')
}

/**
 * Inspect one authored source without I/O, session state, or URL rewriting.
 * @param source - destination exactly as parsed from Markdown.
 * @returns the source category and any user-confirmation reason.
 */
export function inspectRemoteImageUrl(source: string): RemoteImageInspection {
  if (WINDOWS_ABSOLUTE_PATH.test(source) || !EXPLICIT_SCHEME.test(source)) {
    return { kind: 'local-source' }
  }

  let url: URL
  try {
    url = new URL(source)
  } catch {
    return { kind: 'blocked' }
  }
  if (url.protocol === 'file:') {
    if (url.hostname !== '' && url.hostname !== 'localhost') return { kind: 'blocked' }
    try {
      fileURLToPath(url)
      return { kind: 'local-source' }
    } catch {
      return { kind: 'blocked' }
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked' }
  if (url.username !== '' || url.password !== '') return { kind: 'blocked' }
  if (containsPotentialSecret(url)) {
    return { kind: 'confirmation-required', reason: 'potential-secret', origin: url.origin }
  }
  if (isLocalImageHostname(url.hostname)) {
    return { kind: 'confirmation-required', reason: 'private-origin', origin: url.origin }
  }
  return { kind: 'allowed' }
}

/**
 * Apply exact deployment exceptions to one URL-only inspection.
 * @param source - destination exactly as parsed from Markdown.
 * @param trustedOrigins - private origins allowed to load automatically.
 * @returns a browser URL, confirmation, refusal, or local-import delegation.
 */
export function resolveRemoteImage(
  source: string,
  trustedOrigins: ReadonlySet<string>,
): RemoteImageDecision {
  const inspection = inspectRemoteImageUrl(source)
  switch (inspection.kind) {
    case 'local-source':
      return undefined
    case 'allowed':
      return { kind: 'remote', url: source }
    case 'confirmation-required':
      if (inspection.reason === 'private-origin' && trustedOrigins.has(inspection.origin)) {
        return { kind: 'remote', url: source }
      }
      return { kind: 'confirmation-required', reason: inspection.reason }
    case 'blocked':
      return { kind: 'blocked' }
    default:
      return assertNever(inspection)
  }
}
