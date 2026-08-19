import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const fixtureRoot = fileURLToPath(new URL('../../../packages/compat/agent-plugins/tests/fixtures/snapshot/', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/compat/agent-plugins/run.ts', import.meta.url))
const config = fileURLToPath(new URL('./fixtures/compat/agent-plugins/cordis.yml', import.meta.url))
const expected = fileURLToPath(new URL('./fixtures/compat/agent-plugins/output.expected.json', import.meta.url))

it('discovers a project Claude plugin and exercises its skill, command, and MCP server through the real Loader', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-snapshot-'))
  const projectDir = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-project-'))
  try {
    const { stdout } = await execute(process.execPath, [
      '--import',
      import.meta.resolve('tsx'),
      driver,
      config,
    ], {
      env: {
        ...process.env,
        DSH_AGENT_PLUGIN_FIXTURE: fixtureRoot,
        DSH_AGENT_PLUGIN_PROJECT: projectDir,
        DSH_AGENT_PLUGIN_DATA: dataDir,
        DSH_HOME: join(dataDir, 'dsh-home'),
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      },
    })
    await expect(stdout).toMatchFileSnapshot(expected)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  }
}, 30_000)
