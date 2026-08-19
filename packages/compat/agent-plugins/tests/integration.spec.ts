import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as AgentPlugins from '@deepseek-ai/dsh-agent-plugins'
import { serverNamespace } from '@deepseek-ai/dsh-agent-plugins/portable'
import SkillRegistry, { type SkillProvider } from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const runtimeFixture = fileURLToPath(new URL('./fixtures/runtime/', import.meta.url))
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-agent-plugins-${label}-`))
  temporaryRoots.push(path)
  return path
}

async function mountBase(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  return ctx
}

function overridingProvider(): SkillProvider {
  return {
    name: 'integration-override',
    list: () => Promise.resolve([{
      name: 'runtime-skill',
      description: 'Lower rank wins.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'integration',
      provider: 'integration-override',
      rank: 500,
      locator: 'override',
    }]),
    get: candidate => Promise.resolve({
      name: candidate.name,
      description: candidate.description,
      content: 'override',
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
    }),
  }
}

async function executeText(ctx: Context, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await ctx.tools.execute({
    callId: `agent-plugin-${Date.now()}` as never,
    signal: new AbortController().signal,
    name,
    arguments: args,
  })
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error(`expected text result, got ${JSON.stringify(result.content)}`)
  return first.text
}

async function eventually<T>(operation: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await operation()
      if (accept(value)) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition did not settle', { cause: lastError })
}

describe('Cordis Agent Plugins adapter', () => {
  it('registers a parsed in-memory provider at bundled precedence and unregisters it on disposal', async () => {
    const ctx = await mountBase()
    const dataDir = await temporaryDirectory('skill-data')
    const fiber = ctx.plugin(AgentPlugins, { root: runtimeFixture, dataDir })
    await fiber

    const listed = await ctx.skills.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      name: 'runtime-skill',
      source: 'agent-plugin',
      resourceBase: { kind: 'directory', path: join(runtimeFixture, 'skills', 'runtime-skill') },
    })
    expect(listed[0]?.provider).toMatch(/^agent-plugin:runtime-fixture:[0-9a-f]{12}$/)
    const loaded = await ctx.skills.get('runtime-skill')
    expect(loaded?.content).toContain('RUNTIME_SKILL_OK')

    ctx.skills.registerProvider(() => overridingProvider())
    expect((await ctx.skills.list())[0]?.provider).toBe('integration-override')

    await fiber.dispose()
    expect((await ctx.skills.list())[0]?.provider).toBe('integration-override')
    await ctx.fiber.dispose()
  }, 20_000)

  it('owns independent MCP children, survives a sibling startup failure, reconnects, and disposes every tool', async () => {
    const ctx = await mountBase()
    const dataDir = await temporaryDirectory('mcp-data')
    const fiber = ctx.plugin(AgentPlugins, {
      root: runtimeFixture,
      dataDir,
      mcp: {
        toolCallTimeoutMs: 5_000,
        reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 20 },
      },
    })
    await fiber
    const root = fileURLToPath(new URL('./fixtures/runtime/', import.meta.url)).replace(/\/$/, '')
    const instanceHash = createHash('sha256').update(root).digest('hex').slice(0, 12)
    const namespace = serverNamespace('runtime-fixture', 'runtime', instanceHash)
    const probe = `mcp__${namespace}__probe`
    const crash = `mcp__${namespace}__crash_once`

    expect(await executeText(ctx, probe)).toBe('AGENT_PLUGIN_MCP_OK')
    expect(await executeText(ctx, crash)).toBe('crashing once')
    expect(await eventually(() => executeText(ctx, probe, { value: 'RECONNECTED' }), value => value === 'RECONNECTED'))
      .toBe('RECONNECTED')
    expect(await readFile(join(dataDir, 'crashed'), 'utf8')).toBe('1\n')

    await fiber.dispose()
    expect(ctx.tools.get(probe)).toBeUndefined()
    expect(ctx.tools.get(crash)).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
    await ctx.fiber.dispose()
  }, 30_000)

  it('replaces the complete row when configuration HMR disposes and remounts it', async () => {
    const ctx = await mountBase()
    const firstData = await temporaryDirectory('hmr-first')
    const first = ctx.plugin(AgentPlugins, { root: runtimeFixture, dataDir: firstData })
    await first
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['runtime-skill'])

    await first.dispose()
    expect(await ctx.skills.list()).toEqual([])
    const secondRoot = await temporaryDirectory('hmr-root')
    await writeFile(join(secondRoot, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'replacement',
    }))
    await mkdir(join(secondRoot, 'skills', 'replacement-skill'), { recursive: true })
    await writeFile(join(secondRoot, 'skills', 'replacement-skill', 'SKILL.md'), [
      '---',
      'name: replacement-skill',
      'description: Replacement skill.',
      '---',
      'replacement body',
      '',
    ].join('\n'))
    const second = ctx.plugin(AgentPlugins, {
      root: secondRoot,
      dataDir: await temporaryDirectory('hmr-second'),
    })
    await second

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['replacement-skill'])
    await second.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])
    await ctx.fiber.dispose()
  }, 20_000)
})

describe('adapter exports', () => {
  it('exposes Loader-compatible named exports and resolves configuration', () => {
    expect(AgentPlugins.name).toBe('agent-plugins')
    expect(AgentPlugins.inject).toEqual(['skills', 'tools'])
    expect(AgentPlugins.Config({ root: runtimeFixture })).toMatchObject({ root: runtimeFixture })
  })
})
