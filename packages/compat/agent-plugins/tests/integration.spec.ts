import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AgentPlugins from '@deepseek-ai/dsh-agent-plugins'
import { serverNamespace } from '@deepseek-ai/dsh-agent-plugins/portable'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SettingsProvider from '@deepseek-ai/dsh-settings'

const runtimeFixture = fileURLToPath(new URL('./fixtures/runtime/', import.meta.url)).replace(/\/$/u, '')
const temporaryRoots: string[] = []

afterEach(async () => Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))))

class MemoryCredentials extends CredentialProvider {
  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }
  override describe(_ref: CredentialRef): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: false }) }
  override set(): Promise<void> { return Promise.reject(new Error('read only')) }
  override unset(): Promise<void> { return Promise.reject(new Error('read only')) }
}

class MemorySettings extends SettingsProvider {
  override readonly writable: boolean = true
  protected override load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected override persist(): Promise<void> { return Promise.resolve() }
}
class ReadOnlySettings extends MemorySettings { override readonly writable = false }

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-agent-plugins-${label}-`))
  temporaryRoots.push(path)
  return path
}

async function mountBase(readOnly = false): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(readOnly ? ReadOnlySettings : MemorySettings)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function config(dataRoot: string): AgentPlugins.Config {
  return {
    discovery: { defaults: [], sources: [{ id: 'runtime', path: runtimeFixture, base: 'absolute', layout: 'plugin' }] },
    dataRoot,
  }
}

async function createAgent(ctx: Context, cwd: string, id: string) {
  return (await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })).agent
}

async function createUserAgent(ctx: Context, id: string) {
  return (await ctx.agents.create({ sessionId: SessionId(id) })).agent
}

async function executeText(ctx: Context, agent: Awaited<ReturnType<typeof createAgent>>, name: string, value: string): Promise<string> {
  const result = await ctx.tools.execute({
    agent, callId: CallId(`plugin-${value}`), signal: new AbortController().signal, name, arguments: { value },
  })
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error('expected text MCP result')
  return first.text
}

describe('per-agent compatibility generations', () => {
  it('attaches only during agent creation and removes generations with their owners', async () => {
    const ctx = await mountBase()
    const cwd = await temporaryDirectory('workspace')
    const existing = await createAgent(ctx, cwd, 'existing')
    const row = ctx.plugin(AgentPlugins, config(await temporaryDirectory('data')))
    await row

    expect(await ctx.skills.list({ scope: existing })).toEqual([])
    const created = await createAgent(ctx, cwd, 'created')
    expect((await ctx.skills.list({ scope: created })).map(skill => skill.name)).toEqual(['runtime-skill'])
    expect(ctx.agentPlugin.list(created).entries).toEqual([
      expect.objectContaining({ name: 'runtime-fixture', source: 'runtime', format: 'agent-plugins', skillCount: 1, mcpServerCount: 2 }),
    ])
    expect(JSON.stringify(ctx.agentPlugin.list(created))).not.toContain(runtimeFixture)

    await created.ctx.fiber.dispose()
    expect(ctx.agentPlugin.list(created).entries).toEqual([])
    const replacement = await createAgent(ctx, cwd, 'replacement')
    expect((await ctx.skills.list({ scope: replacement })).map(skill => skill.name)).toEqual(['runtime-skill'])
    await row.dispose()
    expect(await ctx.skills.list({ scope: replacement })).toEqual([])
    await ctx.fiber.dispose()
  }, 20_000)

  it('allows the same stable MCP namespace in separate agent scopes', async () => {
    const ctx = await mountBase()
    const cwd = await temporaryDirectory('workspace')
    const dataRoot = await temporaryDirectory('data')
    await ctx.plugin(AgentPlugins, config(dataRoot))
    const first = await createAgent(ctx, cwd, 'first')
    const second = await createAgent(ctx, cwd, 'second')
    const identity = `configured:runtime:${basename(runtimeFixture)}`
    const namespace = serverNamespace('runtime-fixture', 'runtime', createHash('sha256').update(identity).digest('hex').slice(0, 12))
    const tool = `mcp__${namespace}__probe`

    expect(await executeText(ctx, first, tool, 'FIRST')).toBe('FIRST')
    expect(await executeText(ctx, second, tool, 'SECOND')).toBe('SECOND')
    await first.ctx.fiber.dispose()
    expect(ctx.tools.get(tool, first)).toBeUndefined()
    expect(await executeText(ctx, second, tool, 'SURVIVED')).toBe('SURVIVED')
    await ctx.fiber.dispose()
  }, 20_000)

  it('persists workspace toggles for new agents without changing the live generation', async () => {
    const ctx = await mountBase()
    const firstWorkspace = await temporaryDirectory('first-workspace')
    const secondWorkspace = await temporaryDirectory('second-workspace')
    await ctx.plugin(AgentPlugins, config(await temporaryDirectory('data')))
    const current = await createAgent(ctx, firstWorkspace, 'toggle-current')

    expect((await ctx.skills.list({ scope: current })).map(skill => skill.name)).toEqual(['runtime-skill'])
    const pending = await ctx.agentPlugin.setEnabled(current, ctx.agentPlugin.list(current).entries[0]!.qualifiedId, false)
    expect(pending.entries[0]).toMatchObject({ enabled: false, status: 'partial' })
    expect((await ctx.skills.list({ scope: current })).map(skill => skill.name)).toEqual(['runtime-skill'])

    const disabled = await createAgent(ctx, firstWorkspace, 'toggle-disabled')
    expect(ctx.agentPlugin.list(disabled).entries[0]).toMatchObject({ enabled: false, status: 'disabled' })
    expect(ctx.agentPlugin.list(disabled).entries[0]!.skillCount).toBeUndefined()
    expect(await ctx.skills.list({ scope: disabled })).toEqual([])

    const otherWorkspace = await createAgent(ctx, secondWorkspace, 'toggle-other-workspace')
    expect(ctx.agentPlugin.list(otherWorkspace).entries[0]).toMatchObject({ enabled: true, status: 'partial' })
    await ctx.agentPlugin.setEnabled(disabled, ctx.agentPlugin.list(disabled).entries[0]!.qualifiedId, true)
    expect(ctx.agentPlugin.list(disabled).entries[0]).toMatchObject({ enabled: true, status: 'disabled' })
    const enabled = await createAgent(ctx, firstWorkspace, 'toggle-enabled')
    expect(ctx.agentPlugin.list(enabled).entries[0]).toMatchObject({ enabled: true, status: 'partial' })
    await ctx.fiber.dispose()
  }, 20_000)

  it('rejects toggle writes from a read-only settings provider', async () => {
    const ctx = await mountBase(true)
    await ctx.plugin(AgentPlugins, config(await temporaryDirectory('data')))
    const agent = await createAgent(ctx, await temporaryDirectory('workspace'), 'read-only')
    const snapshot = ctx.agentPlugin.list(agent)
    expect(snapshot.writable).toBe(false)
    await expect(ctx.agentPlugin.setEnabled(agent, snapshot.entries[0]!.qualifiedId, false)).rejects.toThrow(/read-only/u)
    await ctx.fiber.dispose()
  })

  it('shares the user bucket and serializes concurrent toggle writes', async () => {
    const ctx = await mountBase()
    await ctx.plugin(AgentPlugins, config(await temporaryDirectory('data')))
    const current = await createUserAgent(ctx, 'user-current')
    const id = ctx.agentPlugin.list(current).entries[0]!.qualifiedId

    await Promise.all([
      ctx.agentPlugin.setEnabled(current, id, false),
      ctx.agentPlugin.setEnabled(current, id, true),
    ])
    expect(ctx.agentPlugin.list(current).entries[0]).toMatchObject({ enabled: true, status: 'partial' })
    await ctx.agentPlugin.setEnabled(current, id, false)
    const replacement = await createUserAgent(ctx, 'user-replacement')
    expect(ctx.agentPlugin.list(replacement).entries[0]).toMatchObject({ enabled: false, status: 'disabled' })
    await ctx.fiber.dispose()
  }, 20_000)

  it('rejects a second active compatibility row', async () => {
    const ctx = await mountBase()
    await ctx.plugin(AgentPlugins, { discovery: { defaults: [] } })
    await expect(ctx.plugin(AgentPlugins, { discovery: { defaults: [] } })).rejects.toThrow(/only one agent-plugins row/u)
    await ctx.fiber.dispose()
  })
})

describe('adapter exports', () => {
  it('exposes the reduced Loader configuration', () => {
    expect(AgentPlugins.inject).toEqual(['agents', 'skills', 'tools', 'commands', 'credentials', 'settings'])
    expect(AgentPlugins.Config({})).toMatchObject({ discovery: { defaults: ['dsh', 'agents', 'claude'] } })
    expect(AgentPlugins.Config({ discovery: { defaults: [] } })).toMatchObject({ discovery: { defaults: [] } })
  })
})
