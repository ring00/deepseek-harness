import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const mockMcp = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  failure: undefined as unknown,
}))

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  name: 'mock-mcp-client',
  inject: [],
  Config: (config: Record<string, unknown>) => {
    mockMcp.configs.push(config)
    if (mockMcp.failure !== undefined) throw mockMcp.failure
    return config
  },
  apply: async (_ctx: Context): Promise<void> => {},
}))

import * as AgentPlugins from '@deepseek-ai/dsh-agent-plugins'

const temporaryRoots: string[] = []

afterEach(async () => {
  mockMcp.configs.length = 0
  mockMcp.failure = undefined
  vi.unstubAllEnvs()
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-agent-plugins-adapter-${label}-`))
  temporaryRoots.push(path)
  return path
}

async function fixture(): Promise<string> {
  const root = await temporaryDirectory('plugin')
  await writeFile(join(root, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'adapter-fixture',
  }))
  await mkdir(join(root, 'skills', 'plain-skill'), { recursive: true })
  await writeFile(join(root, 'skills', 'plain-skill', 'SKILL.md'), [
    '---',
    'name: plain-skill',
    'description: Skill without optional metadata.',
    '---',
    'plain body',
    '',
  ].join('\n'))
  await mkdir(join(root, 'skills', 'metadata-skill'))
  await writeFile(join(root, 'skills', 'metadata-skill', 'SKILL.md'), [
    '---',
    'name: metadata-skill',
    'description: Skill with optional metadata.',
    'license: MIT',
    '---',
    'metadata body',
    '',
  ].join('\n'))
  await writeFile(join(root, 'server.mjs'), '')
  await writeFile(join(root, 'mcp.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      local: { type: 'stdio', command: './server.mjs' },
      remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
    },
  }))
  return root
}

async function mountBase(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  return ctx
}

describe('Cordis adapter translation edges', () => {
  it('uses the default persistent root and mounts both native MCP transports', async () => {
    const root = await fixture()
    const home = await temporaryDirectory('home')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('PATH', '')
    const ctx = await mountBase()
    const fiber = ctx.plugin(AgentPlugins, { root })
    await fiber

    expect(mockMcp.configs).toHaveLength(2)
    const stdio = mockMcp.configs.find(config => config.transport === 'stdio')
    const http = mockMcp.configs.find(config => config.transport === 'streamable-http')
    expect(stdio?.command).toMatch(/\/server\.mjs$/)
    expect(http?.url).toBe('https://example.com/mcp')
    const skill = (await ctx.skills.list()).find(value => value.name === 'plain-skill')
    expect(skill).not.toHaveProperty('metadata')
    expect(await ctx.skills.get('plain-skill')).not.toHaveProperty('metadata')
    expect(await ctx.skills.get('metadata-skill')).toHaveProperty('metadata')

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('contains non-Error child failures and owns their inert disposal effects', async () => {
    const root = await fixture()
    const dataDir = await temporaryDirectory('data')
    const ctx = await mountBase()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    mockMcp.failure = 'mock mount failure'
    const fiber = ctx.plugin(AgentPlugins, {
      root,
      dataDir,
      mcp: {
        toolCallTimeoutMs: 123,
        reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 },
      },
    })
    await fiber

    expect(warnings.filter(message => message.includes('mock mount failure'))).toHaveLength(2)
    expect(await ctx.skills.get('plain-skill')).toBeDefined()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('accepts the public apply interface without Loader-defaulted MCP policy', async () => {
    const root = await fixture()
    const dataDir = await temporaryDirectory('direct-data')
    const ctx = await mountBase()
    await AgentPlugins.apply(ctx, { root, dataDir })

    expect(mockMcp.configs).toHaveLength(2)
    expect(mockMcp.configs.every(config => !Object.hasOwn(config, 'toolCallTimeoutMs'))).toBe(true)
    expect(mockMcp.configs.every(config => !Object.hasOwn(config, 'reconnect'))).toBe(true)
    await ctx.fiber.dispose()
  })
})
