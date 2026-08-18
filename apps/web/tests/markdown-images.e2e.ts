// Web e2e scenario: automatic Markdown image policy. Trusted and untrusted
// loopback origins plus a local workspace file prove exact URL preservation,
// click confirmation, and immutable local replay.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/markdown-images', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/markdown-images/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'markdown-images-web-e2e'
const SAFE_ALT = 'Safe query image'
const SECRET_ALT = 'Potential secret image'
const PRIVATE_ALT = 'Private origin image'
const LOCAL_ALT = 'Local test image'
const SECRET_DETAILS = 'This image URL may contain sensitive information. Activate to load it exactly as written.'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

interface ImageOrigin {
  server: Server
  origin: string
  requests: Array<{ path: string | undefined; referer: string | undefined }>
}

function suspiciousToken(): string {
  return ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234'].join('_')
}

/** Start the deterministic remote image origin used by this browser scenario. */
async function startImageOrigin(): Promise<ImageOrigin> {
  const requests: ImageOrigin['requests'] = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, referer: request.headers.referer })
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': PNG.length,
      'content-type': 'image/png',
    })
    response.end(PNG)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('image origin did not expose an IP socket')
  }
  return {
    server,
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
  }
}

/** Stop one image origin after the browser and host release their requests. */
async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Build one closed session fixture covering every policy branch. */
function markdownImageFixture(trustedOrigin: string, untrustedOrigin: string): string {
  const session = Session.create(SessionId('markdown-image-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{
      type: 'text',
      text: 'Show the Markdown image policy.',
    }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Markdown image policy',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '## Markdown images',
          '',
          `![${SAFE_ALT}](${trustedOrigin}/safe.png?signature=unchanged#preview)`,
          '',
          `![${SECRET_ALT}](${trustedOrigin}/secret.png?credential=${suspiciousToken()})`,
          '',
          `![${PRIVATE_ALT}](${untrustedOrigin}/private.png?signature=unchanged)`,
          '',
          `![${LOCAL_ALT}](./local-image.png)`,
          '',
          'REMOTE_IMAGE_DONE',
        ].join('\n'),
      }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const header = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: '{{sessionId}}',
    createdAt: 0,
    cwd: '{{cwd}}',
  }
  return [
    JSON.stringify(header),
    // Spaced event times, exactly as the sibling markdown fixtures pin them:
    // the stats line renders its LLM segment only while the step's measured
    // milliseconds exceed zero, so a fixture that leaves the times unset lets
    // the replay's own speed decide whether the golden matches.
    ...session.events.map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: automatic Markdown image policy', () => {
  let scaffold: WebScaffold
  let trustedOrigin: ImageOrigin
  let untrustedOrigin: ImageOrigin
  let overlayRoot: string
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    trustedOrigin = await startImageOrigin()
    untrustedOrigin = await startImageOrigin()
    overlayRoot = await mkdtemp(join(tmpdir(), 'dsh-markdown-images-e2e-'))
    const overlay = join(overlayRoot, 'cordis.patch.yml')
    await writeFile(overlay, [
      '- id: ui-markdown-images',
      '  config:',
      '    trustedOrigins:',
      `      - ${JSON.stringify(trustedOrigin.origin)}`,
      '',
    ].join('\n'))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await writeFile(join(scaffold.workspaceCwd, 'local-image.png'), PNG)
    await seedSession(scaffold, markdownImageFixture(trustedOrigin.origin, untrustedOrigin.origin), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await stopServer(trustedOrigin.server)
    await stopServer(untrustedOrigin.server)
    await rm(overlayRoot, { recursive: true, force: true })
  })

  it.skipIf(MODE === 'record')('preserves safe URLs, confirms risky URLs, and replays a deleted local image', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-images'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText('REMOTE_IMAGE_DONE', { exact: true }).count(), {
      timeout: 15_000,
    }).toBe(1)

    const loadedAlts = [SAFE_ALT, LOCAL_ALT]
    for (const alt of loadedAlts) {
      const image = page.getByRole('img', { name: alt })
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth), {
        timeout: 10_000,
      }).toBeGreaterThan(0)
    }
    for (const alt of [SECRET_ALT, PRIVATE_ALT]) {
      expect(await page.getByRole('img', { name: alt }).count()).toBe(0)
      expect(await page.getByRole('button', { name: alt }).count()).toBe(1)
    }
    expect(untrustedOrigin.requests).toEqual([])
    expect(trustedOrigin.requests).toEqual([
      { path: '/safe.png?signature=unchanged', referer: undefined },
    ])

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
      .split(trustedOrigin.origin).join('{{trustedImageOrigin}}')
      .split(untrustedOrigin.origin).join('{{untrustedImageOrigin}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    const secretConfirmation = page.getByRole('button', { name: SECRET_ALT })
    const describedBy = await secretConfirmation.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(await page.locator(`[id="${describedBy ?? ''}"]`).innerText()).toBe(SECRET_DETAILS)
    await secretConfirmation.focus()
    const tooltip = page.getByRole('tooltip', { name: SECRET_DETAILS, exact: true })
    await tooltip.waitFor({ timeout: 5_000 })
    expect(await tooltip.innerText()).toBe(SECRET_DETAILS)
    await page.getByRole('button', { name: 'Copy' }).first().focus()
    await secretConfirmation.hover()
    await expect.poll(() => tooltip.innerText(), { timeout: 5_000 }).toBe(SECRET_DETAILS)
    await secretConfirmation.focus()
    await secretConfirmation.press('Enter')
    await page.getByRole('button', { name: PRIVATE_ALT }).click()
    for (const alt of [SECRET_ALT, PRIVATE_ALT]) {
      await expect.poll(() => page.getByRole('img', { name: alt }).evaluate(
        element => (element as HTMLImageElement).naturalWidth,
      ), { timeout: 10_000 }).toBeGreaterThan(0)
    }
    expect(trustedOrigin.requests).toContainEqual({
      path: `/secret.png?credential=${suspiciousToken()}`,
      referer: undefined,
    })
    expect(untrustedOrigin.requests).toEqual([
      { path: '/private.png?signature=unchanged', referer: undefined },
    ])

    const image = page.getByRole('img', { name: LOCAL_ALT })
    expect(await image.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        decoding: element.getAttribute('decoding'),
        loading: element.getAttribute('loading'),
        maxWidth: computed.maxWidth,
        referrerPolicy: element.getAttribute('referrerpolicy'),
      }
    })).toEqual({
      decoding: 'async',
      loading: 'lazy',
      maxWidth: '100%',
      referrerPolicy: 'no-referrer',
    })
    await rm(join(scaffold.workspaceCwd, 'local-image.png'))
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.getByText('REMOTE_IMAGE_DONE', { exact: true }).count(), {
      timeout: 15_000,
    }).toBe(1)
    await expect.poll(() => page.getByRole('img', { name: LOCAL_ALT }).evaluate(
      element => (element as HTMLImageElement).naturalWidth,
    ), { timeout: 10_000 }).toBeGreaterThan(0)
    for (const alt of [SECRET_ALT, PRIVATE_ALT]) {
      expect(await page.getByRole('img', { name: alt }).count()).toBe(0)
      expect(await page.getByRole('button', { name: alt }).count()).toBe(1)
    }
    expect(untrustedOrigin.requests).toEqual([
      { path: '/private.png?signature=unchanged', referer: undefined },
    ])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 60_000)
})
