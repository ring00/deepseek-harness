import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadCompatiblePlugin } from '@deepseek-ai/dsh-agent-plugins/adapters'
import { discoverPlugins, type DiscoveredPlugin } from '@deepseek-ai/dsh-agent-plugins/discovery'

const execute = promisify(execFile)
const lockPath = fileURLToPath(new URL('./corpus.lock.json', import.meta.url))

interface CorpusEntry {
  repository: string
  commit: string
  pluginRoot: string
  license: string
  format: 'agent-plugins' | 'claude'
  expected: {
    name: string
    skills: string[]
    commands: Array<{ name: string; partial: boolean }>
    mcp: Array<{ key: string; transport: 'stdio' | 'streamable-http' }>
  }
}

interface CorpusLock {
  version: 2
  plugins: CorpusEntry[]
}

const enabled = process.env.DSH_AGENT_PLUGINS_CORPUS === '1'

describe.skipIf(!enabled)('pinned Agent Plugins and Claude corpus', () => {
  it('discovers and translates every pinned package without starting its servers', async () => {
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as CorpusLock
    expect(lock.version).toBe(2)
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-corpus-'))
    try {
      const checkouts = new Map<string, string>()
      for (const entry of lock.plugins) {
        const key = `${entry.repository}\0${entry.commit}`
        let checkout = checkouts.get(key)
        if (checkout === undefined) {
          checkout = join(temporary, `checkout-${String(checkouts.size)}`)
          await checkoutRevision(checkout, entry)
          checkouts.set(key, checkout)
        }
        await validateEntry(entry, checkout, temporary)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 120_000)
})

async function checkoutRevision(checkout: string, entry: CorpusEntry): Promise<void> {
  await execute('git', ['init', '--quiet', checkout])
  await execute('git', ['-C', checkout, 'remote', 'add', 'origin', entry.repository])
  await execute('git', ['-C', checkout, 'fetch', '--quiet', '--depth=1', 'origin', entry.commit])
  await execute('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
}

async function validateEntry(entry: CorpusEntry, checkout: string, temporary: string): Promise<void> {
  expect(entry.license.length, entry.repository).toBeGreaterThan(0)
  const root = join(checkout, entry.pluginRoot)
  const discovered = await discoverPlugins({
    dshHome: temporary,
    discovery: {
      defaults: [],
      sources: [{ id: entry.expected.name, path: root, layout: 'plugin', format: entry.format }],
    },
  })
  expect(discovered.plugins, entry.repository).toHaveLength(1)
  const plugin = await loadCompatiblePlugin(discovered.plugins[0] as DiscoveredPlugin, {
    dataRoot: join(temporary, 'data'),
    resolveExecutable: command => Promise.resolve(join(temporary, 'resolved-bin', command)),
  })

  expect(plugin.manifest.name, entry.repository).toBe(entry.expected.name)
  expect(plugin.skills.map(skill => skill.name).sort(), entry.repository).toEqual([...entry.expected.skills].sort())
  expect(plugin.commands.map(command => ({ name: command.name, partial: command.partial })), entry.repository)
    .toEqual(entry.expected.commands)
  expect(plugin.mcpServers.map(server => ({ key: server.rawKey, transport: server.transport })), entry.repository)
    .toEqual(entry.expected.mcp)
}
