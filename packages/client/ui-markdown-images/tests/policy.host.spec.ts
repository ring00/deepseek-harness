import { describe, expect, it } from 'vitest'
import {
  inspectRemoteImageUrl,
  isLocalImageHostname,
  normalizeTrustedOrigins,
  resolveRemoteImage,
} from '../src/policy.ts'

function githubToken(): string {
  return ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234'].join('_')
}

function genericSecret(): string {
  return ['sk', 'A9b8C7d6E5f4G3h2I1j0K9l8M7n6O5p4Q3r2S1t0'].join('-')
}

function percentEncode(value: string): string {
  return Array.from(
    value,
    character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  ).join('')
}

describe('Markdown remote image URL inspection', () => {
  it('allows public URLs without rewriting queries or fragments', () => {
    const source = 'https://cdn.example/image.png?expires=123&signature=safe#preview'
    expect(inspectRemoteImageUrl(source)).toEqual({ kind: 'allowed' })
    expect(resolveRemoteImage(source, new Set())).toEqual({ kind: 'remote', url: source })
  })

  it('requires confirmation for high- and medium-confidence secrets', () => {
    const high = `https://cdn.example/image.png?credential=${githubToken()}`
    const medium = `https://cdn.example/image.png?credential=${genericSecret()}`
    expect(inspectRemoteImageUrl(high)).toEqual({
      kind: 'confirmation-required', reason: 'potential-secret', origin: 'https://cdn.example',
    })
    expect(inspectRemoteImageUrl(medium)).toEqual({
      kind: 'confirmation-required', reason: 'potential-secret', origin: 'https://cdn.example',
    })
  })

  it('scans one percent-decoding pass over paths and query fields', () => {
    const encodedPath = `https://cdn.example/${percentEncode(githubToken())}/image.png`
    const encodedQuery = `https://cdn.example/image.png?credential=${percentEncode(genericSecret())}`
    expect(inspectRemoteImageUrl(encodedPath)).toMatchObject({
      kind: 'confirmation-required', reason: 'potential-secret',
    })
    expect(inspectRemoteImageUrl(encodedQuery)).toMatchObject({
      kind: 'confirmation-required', reason: 'potential-secret',
    })
  })

  it('ignores fragments because browsers do not send them', () => {
    const source = `https://cdn.example/image.png#${githubToken()}`
    expect(inspectRemoteImageUrl(source)).toEqual({ kind: 'allowed' })
    expect(resolveRemoteImage(source, new Set())).toEqual({ kind: 'remote', url: source })
  })

  it('classifies local sources independently from hard remote refusals', () => {
    for (const source of ['file:///tmp/image.png', String.raw`C:\work\image.png`, './relative.png', '/tmp/image.png']) {
      expect(inspectRemoteImageUrl(source)).toEqual({ kind: 'local-source' })
      expect(resolveRemoteImage(source, new Set())).toBeUndefined()
    }
    for (const source of [
      'https://user:password@example.com/image.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'https://[invalid',
      'file://remote-host/image.png',
      'file:///tmp/image%2Fname.png',
    ]) {
      expect(inspectRemoteImageUrl(source)).toEqual({ kind: 'blocked' })
      expect(resolveRemoteImage(source, new Set())).toEqual({ kind: 'blocked' })
    }
  })

  it('requires confirmation for local names and literal private destinations', () => {
    for (const source of [
      'http://localhost/image.png',
      'http://service/image.png',
      'http://host.local/image.png',
      'http://127.0.0.1/image.png',
      'http://10.1.2.3/image.png',
      'http://169.254.1.2/image.png',
      'http://192.168.1.2/image.png',
      'http://[::1]/image.png',
      'http://[fd00::1]/image.png',
      'http://[fe80::1]/image.png',
      'http://[ff02::1]/image.png',
      'http://[::ffff:127.0.0.1]/image.png',
    ]) {
      expect(inspectRemoteImageUrl(source)).toMatchObject({
        kind: 'confirmation-required', reason: 'private-origin',
      })
      expect(resolveRemoteImage(source, new Set())).toEqual({
        kind: 'confirmation-required', reason: 'private-origin',
      })
    }
  })

  it('uses trusted origins only to promote private destinations', () => {
    const trusted = normalizeTrustedOrigins(['http://127.0.0.1:8080'])
    const safe = 'http://127.0.0.1:8080/image.png?signature=safe#preview'
    const suspicious = `http://127.0.0.1:8080/image.png?credential=${githubToken()}`
    expect(resolveRemoteImage(safe, trusted)).toEqual({ kind: 'remote', url: safe })
    expect(resolveRemoteImage('http://127.0.0.1:8081/image.png', trusted)).toEqual({
      kind: 'confirmation-required', reason: 'private-origin',
    })
    expect(resolveRemoteImage(suspicious, trusted)).toEqual({
      kind: 'confirmation-required', reason: 'potential-secret',
    })
  })

  it('fails plugin configuration on anything other than an exact HTTP(S) origin', () => {
    for (const entry of [
      'file:///tmp',
      'https://user@example.com',
      'https://example.com/path',
      'https://example.com/?query=x',
      'not a URL',
    ]) {
      expect(() => normalizeTrustedOrigins([entry])).toThrow(/trustedOrigins/)
    }
    expect(normalizeTrustedOrigins(['HTTPS://EXAMPLE.COM:443'])).toEqual(new Set(['https://example.com']))
  })

  it('classifies local names and literal private ranges without DNS resolution', () => {
    for (const host of [
      'localhost', 'api', 'printer.local', '127.9.8.7', '172.16.0.1', '172.31.255.255',
      '[::ffff:7f00:1]',
    ]) {
      expect(isLocalImageHostname(host)).toBe(true)
    }
    for (const host of ['example.com', '172.32.0.1', '192.0.2.1']) {
      expect(isLocalImageHostname(host)).toBe(false)
    }
  })
})
