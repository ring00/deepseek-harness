import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/complete/', import.meta.url))
const built = existsSync(join(packageRoot, 'lib/index.js'))
  && existsSync(join(packageRoot, 'lib/invariant.js'))
  && existsSync(join(packageRoot, 'schemas/1.0.0/plugin.schema.json'))

describe.runIf(built)('built dsh-agent-plugins package', () => {
  it('loads both exports under plain Node and reads vendored schemas from the package', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-built-'))
    const script = [
      'const plugin = await import("@deepseek-ai/dsh-agent-plugins")',
      'const portable = await import("@deepseek-ai/dsh-agent-plugins/portable")',
      'const loaded = await portable.loadAgentPlugin(process.argv[1], {',
      '  defaultDataRoot: process.argv[2],',
      '  resolveExecutable: command => Promise.resolve(`/resolved/${command}`),',
      '})',
      'console.log(JSON.stringify({ name: plugin.name, skill: loaded.skills[0]?.name, mcp: loaded.mcpServers.length }))',
    ].join('\n')
    try {
      const { stdout } = await execute(process.execPath, [
        '--input-type=module',
        '--eval',
        script,
        fixtureRoot,
        dataRoot,
      ], { cwd: packageRoot })

      expect(JSON.parse(stdout) as unknown).toEqual({ name: 'agent-plugins', skill: 'fixture-skill', mcp: 2 })
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })
})
