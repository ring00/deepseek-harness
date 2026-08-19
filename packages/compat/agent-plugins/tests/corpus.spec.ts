import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadAgentPlugin } from '@deepseek-ai/dsh-agent-plugins/portable'

const execute = promisify(execFile)
const lockPath = fileURLToPath(new URL('./corpus.lock.json', import.meta.url))

interface CorpusEntry {
  repository: string
  commit: string
  pluginRoot: string
  license: string
  expected: {
    skills: string[]
    mcp: Array<{ key: string; transport: 'stdio' | 'streamable-http' }>
  }
}

interface CorpusLock {
  version: 1
  plugins: CorpusEntry[]
}

const enabled = process.env.DSH_AGENT_PLUGINS_CORPUS === '1'

describe.skipIf(!enabled)('pinned Agent Plugins corpus', () => {
  it('discovers and translates every pinned package without starting its servers', async () => {
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as CorpusLock
    expect(lock.version).toBe(1)
    for (const entry of lock.plugins) await validateEntry(entry)
  }, 120_000)
})

async function validateEntry(entry: CorpusEntry): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-corpus-'))
  const checkout = join(temporary, 'checkout')
  try {
    await execute('git', ['init', '--quiet', checkout])
    await execute('git', ['-C', checkout, 'remote', 'add', 'origin', entry.repository])
    await execute('git', ['-C', checkout, 'fetch', '--quiet', '--depth=1', 'origin', entry.commit])
    await execute('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
    const plugin = await loadAgentPlugin(join(checkout, entry.pluginRoot), {
      defaultDataRoot: join(temporary, 'data'),
      resolveExecutable: command => Promise.resolve(join(temporary, 'resolved-bin', command)),
    })

    expect(plugin.manifest.license, entry.repository).toBe(entry.license)
    expect(plugin.skills.map(skill => skill.name).sort(), entry.repository).toEqual([...entry.expected.skills].sort())
    expect(plugin.mcpServers.map(server => ({ key: server.rawKey, transport: server.transport })), entry.repository)
      .toEqual(entry.expected.mcp)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
