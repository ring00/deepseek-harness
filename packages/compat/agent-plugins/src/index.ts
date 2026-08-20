/** Per-agent Agent Plugins and Claude Code compatibility service. */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillDefinition, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { expandClaudeCommand, inspectCompatibleManifest, loadCompatiblePlugin, type LoadedCompatiblePlugin } from './adapters.ts'
import { discoverPlugins, type BuiltinSource, type DiscoverySource } from './discovery.ts'
import type { PortableMcpServer, PortableSkill } from './portable.ts'
import type { AgentPluginEntry, AgentPluginQualifiedId, AgentPluginSnapshot } from './types.ts'

export * from './portable.ts'
export * from './discovery.ts'
export * from './adapters.ts'
export type * from './types.ts'

/** Agent Plugins discovery and MCP policy. */
export interface Config {
  /** Installation families and custom locations scanned once for each new or resumed agent. */
  discovery?: {
    /** Built-in source families; defaults to DSH, Agents, and Claude, while an empty list disables all. */
    defaults?: BuiltinSource[]
    /** Absolute home-directory overrides for built-in DSH, Agents, or Claude sources. */
    homes?: Partial<Record<BuiltinSource, string>>
    /** Highest-priority plugin roots or immediate-child containers, evaluated in declaration order. */
    sources?: DiscoverySource[]
  }
  /** Persistent plugin-data root; defaults to `$DSH_HOME/agent-plugins/data`. */
  dataRoot?: string
  /** MCP client policy forwarded to every accepted server. */
  mcp?: {
    /** Maximum duration of one MCP tool call in milliseconds. */
    toolCallTimeoutMs?: number
    /** Reconnection policy for the official MCP client. */
    reconnect?: ReconnectConfig
  }
}

const Source: Schema<DiscoverySource> = z.object({
  id: z.string().required(), path: z.string().required(),
  base: z.union(['absolute', 'project'] as const),
  layout: z.union(['plugin', 'children'] as const),
  format: z.union(['auto', 'agent-plugins', 'claude'] as const),
})
const Reconnect: Schema<ReconnectConfig> = z.object({
  enabled: z.boolean(), initialDelayMs: z.number().min(1), maxDelayMs: z.number().min(1),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

/** Loader configuration schema. */
export const Config: Schema<Config> = z.object({
  discovery: z.object({
    defaults: z.array(z.union(['dsh', 'agents', 'claude'] as const)).default(['dsh', 'agents', 'claude']),
    homes: z.object({ dsh: z.string(), agents: z.string(), claude: z.string() }),
    sources: z.array(Source),
  }),
  dataRoot: z.string(),
  mcp: z.object({ toolCallTimeoutMs: z.number().min(1), reconnect: Reconnect }),
})

export const name = 'agent-plugins'
export const inject = ['agents', 'skills', 'tools', 'commands', 'credentials', 'settings']

/** Durable source for a queued legacy Claude command prompt. */
export interface AgentPluginCommandMessageSource {
  readonly kind: 'agent-plugin-command'
  readonly plugin: string
  readonly command: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'agent-plugin-command': AgentPluginCommandMessageSource }
}

interface AgentPluginSettings { disabled: Record<string, string[]> }
interface InventoryGeneration { workspaceKey: string; snapshot: AgentPluginSnapshot }
const SettingsSchema: Schema<AgentPluginSettings> = z.object({ disabled: z.dict(z.array(z.string())).default({}) })
const EMPTY: AgentPluginSnapshot = Object.freeze({ writable: false, entries: Object.freeze([]) })

/** Workspace plugin catalog with desired state over each immutable live generation. */
export class AgentPluginInventory extends TypertRemoteService {
  private readonly generations = new Map<Agent, InventoryGeneration>()
  private readonly settings: SettingsScope<AgentPluginSettings>
  private writes = Promise.resolve()
  private acceptingWrites = true
  constructor(ctx: Context, settings: SettingsScope<AgentPluginSettings>) {
    super(ctx, 'agentPlugin')
    this.settings = settings
    ctx.effect(() => async () => { this.acceptingWrites = false; await this.writes }, 'agent-plugins.settings-writes')
  }
  /**
   * Publish one generation immediately before its agent becomes visible.
   * @param agent - exact agent that owns the generation.
   * @param workspaceKey - path-free settings bucket for the generation.
   * @param snapshot - immutable inventory to publish.
   */
  set(agent: Agent, workspaceKey: string, snapshot: AgentPluginSnapshot): void {
    this.generations.set(agent, { workspaceKey, snapshot })
  }
  /**
   * Remove one exact generation during row or agent teardown.
   * @param agent - exact agent that owned the generation.
   * @param snapshot - exact snapshot being disposed.
   */
  remove(agent: Agent, snapshot: AgentPluginSnapshot): void {
    if (this.generations.get(agent)?.snapshot === snapshot) this.generations.delete(agent)
  }
  /**
   * Read the selected live agent's catalog and current desired states.
   * @param agent - selected live agent.
   * @returns its inventory or an empty snapshot.
   */
  @Remote('list')
  list(agent: Agent): AgentPluginSnapshot {
    const generation = this.generations.get(agent)
    if (generation === undefined) return EMPTY
    const disabled = new Set(this.settings.get().disabled[generation.workspaceKey] ?? [])
    return Object.freeze({
      writable: this.ctx.settings.writable,
      entries: Object.freeze(generation.snapshot.entries.map(entry => Object.freeze({
        ...entry, enabled: !disabled.has(entry.qualifiedId),
      }))),
    })
  }

  /**
   * Persist one workspace activation choice without changing the live generation.
   * @param agent - selected live agent whose catalog authorizes the plugin id.
   * @param qualifiedId - discovered plugin identity.
   * @param enabled - desired state for future agent generations.
   * @returns the current generation with its updated desired states.
   */
  @Remote('setEnabled')
  async setEnabled(agent: Agent, qualifiedId: AgentPluginQualifiedId, enabled: boolean): Promise<AgentPluginSnapshot> {
    if (!this.acceptingWrites) throw new Error('agent plugin inventory is stopping')
    if (!this.ctx.settings.writable) throw new Error('agent plugin settings are read-only')
    const operation = this.writes.then(async () => {
      const generation = this.generations.get(agent)
      if (generation === undefined || !generation.snapshot.entries.some(entry => entry.qualifiedId === qualifiedId)) {
        throw new Error('agent plugin is not part of the selected workspace catalog')
      }
      const current = this.settings.get().disabled
      const disabled = Object.fromEntries(Object.entries(current).map(([key, ids]) => [key, [...new Set(ids)]]))
      const ids = new Set(disabled[generation.workspaceKey] ?? [])
      if (enabled) ids.delete(qualifiedId); else ids.add(qualifiedId)
      if (ids.size === 0) {
        const { [generation.workspaceKey]: _removed, ...remaining } = disabled
        await this.settings.replace({ disabled: remaining })
      } else {
        disabled[generation.workspaceKey] = [...ids].sort()
        await this.settings.replace({ disabled })
      }
    })
    this.writes = operation.then(() => {}, () => {})
    await operation
    return this.list(agent)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { agentPlugin: AgentPluginInventory }
}

const activeRows = new WeakMap<Context, object>()

/** Register discovery for agents created or resumed after this row activates. */
export function apply(ctx: Context, config: Config): void {
  const row = {}
  ctx.effect(() => {
    if (activeRows.has(ctx.root)) throw new Error('only one agent-plugins row may be active; use discovery.sources for additional locations')
    activeRows.set(ctx.root, row)
    return () => { if (activeRows.get(ctx.root) === row) activeRows.delete(ctx.root) }
  }, 'agent-plugins.row')
  const settings = ctx.settings.register(settingsNamespace('agent-plugins'), SettingsSchema, { applies: 'restart' })
  const inventory = new AgentPluginInventory(ctx, settings)
  const dataRoot = config.dataRoot ?? join(resolveDshHome(), 'agent-plugins', 'data')
  const generations = new Map<Agent, Fiber>()
  const unregister = ctx.agents.registerSetup(async (agentCtx, signal) => {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('agent-plugins setup context has no agent')
    let generation: InventoryGeneration | undefined
    const fiber = agentCtx.plugin({
      name: 'agent-plugin-generation', inject,
      async apply(generationCtx: Context): Promise<void> {
        generationCtx.effect(() => () => { generations.delete(agent) }, 'agent-plugins.generation')
        generation = await loadGeneration(generationCtx, agent, config, dataRoot, settings)
        const owned = generation
        generationCtx.effect(() => () => { inventory.remove(agent, owned.snapshot) }, 'agent-plugins.inventory')
      },
    })
    generations.set(agent, fiber)
    try {
      await fiber
      if (signal.aborted) throw signal.reason
      if (generation === undefined) throw new Error('agent-plugin generation produced no inventory')
      const prepared = generation
      return { commit: () => { if (signal.aborted) throw signal.reason; inventory.set(agent, prepared.workspaceKey, prepared.snapshot) } }
    } catch (error) {
      generations.delete(agent)
      await fiber.dispose().catch(() => {})
      throw error
    }
  })
  ctx.effect(() => async () => {
    await unregister()
    await Promise.allSettled([...generations.values()].map(fiber => fiber.dispose()))
    generations.clear()
  }, 'agent-plugins.generations')
}

async function loadGeneration(
  ctx: Context,
  agent: Agent,
  config: Config,
  dataRoot: string,
  settings: SettingsScope<AgentPluginSettings>,
): Promise<InventoryGeneration> {
  const parentEnv = scrubbedParentEnv()
  let discovery
  try {
    discovery = await discoverPlugins({
      ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
      ...config.discovery === undefined ? {} : { discovery: config.discovery },
      dshHome: resolveDshHome(), userHome: homedir(),
      ...process.env.CLAUDE_CONFIG_DIR === undefined ? {} : { claudeHome: process.env.CLAUDE_CONFIG_DIR },
    })
  } catch (error) {
    ctx.logger.warn(`agent-plugins(${agent.id}): workspace discovery failed: ${safeError(error)}`)
    discovery = await discoverPlugins({
      ...config.discovery === undefined ? {} : { discovery: config.discovery },
      dshHome: resolveDshHome(), userHome: homedir(),
    })
  }
  for (const diagnostic of discovery.diagnostics) {
    ctx.logger.warn(`agent-plugins(${agent.id}) ${diagnostic.source}: ${diagnostic.message}`)
  }
  const entries: AgentPluginEntry[] = []
  const workspaceKey = discovery.projectRoot === undefined
    ? 'user'
    : createHash('sha256').update(discovery.projectRoot).digest('hex').slice(0, 12)
  const disabled = new Set(settings.get().disabled[workspaceKey] ?? [])
  for (const candidate of discovery.plugins) {
    const qualifiedId = candidate.qualifiedId as AgentPluginQualifiedId
    if (disabled.has(candidate.qualifiedId)) {
      try {
        const manifest = await inspectCompatibleManifest(candidate)
        entries.push(Object.freeze({
          qualifiedId, name: manifest.name,
          ...manifest.version === undefined ? {} : { version: manifest.version },
          format: candidate.format, source: candidate.sourceLabel, enabled: false, status: 'disabled',
        }))
      } catch (error) {
        entries.push(Object.freeze({
          qualifiedId, name: candidate.qualifiedId.slice(candidate.qualifiedId.lastIndexOf(':') + 1),
          format: candidate.format, source: candidate.sourceLabel, enabled: false, status: 'disabled',
          error: sanitize(safeError(error), [candidate.root, dataRoot]),
        }))
      }
      continue
    }
    let loaded: LoadedCompatiblePlugin
    try {
      loaded = await loadCompatiblePlugin(candidate, {
        dataRoot,
        ...parentEnv.PATH === undefined ? {} : { basePath: parentEnv.PATH },
        resolveCredential: async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
        report: (diagnostic) => {
          ctx.logger.warn(
            `agent-plugins(${agent.id}) ${candidate.qualifiedId} ${diagnostic.subject}: ${diagnostic.message}`,
          )
        },
      })
    } catch (error) {
      entries.push(Object.freeze({
        qualifiedId,
        name: candidate.qualifiedId.slice(candidate.qualifiedId.lastIndexOf(':') + 1),
        format: candidate.format, source: candidate.sourceLabel,
        enabled: true, status: 'failed', skillCount: 0, commandCount: 0, mcpServerCount: 0,
        error: sanitize(safeError(error), [candidate.root, dataRoot]),
      }))
      continue
    }
    try {
      await ctx.plugin({
        name: 'agent-plugin-instance', inject,
        async apply(pluginCtx: Context): Promise<void> {
          pluginCtx.skills.registerProvider(() => memoryProvider(loaded))
          registerCommands(pluginCtx, agent, loaded, discovery.projectRoot)
          await Promise.all(loaded.mcpServers.map(server => mountMcp(pluginCtx, server, config.mcp)))
        },
      })
      const partial = loaded.diagnostics.length > 0
        || loaded.unsupportedComponents.length > 0
        || loaded.commands.some(command => command.partial)
      entries.push(entry(
        qualifiedId,
        candidate.sourceLabel,
        loaded,
        partial ? 'partial' : 'loaded',
      ))
    } catch (error) {
      entries.push({
        ...entry(qualifiedId, candidate.sourceLabel, loaded, 'failed'),
        error: sanitize(safeError(error), [loaded.root, loaded.dataDir]),
      })
    }
  }
  return Object.freeze({ workspaceKey, snapshot: Object.freeze({ writable: ctx.settings.writable, entries: Object.freeze(entries) }) })
}

function entry(id: AgentPluginQualifiedId, source: string, plugin: LoadedCompatiblePlugin, status: AgentPluginEntry['status']): AgentPluginEntry {
  const diagnostic = plugin.diagnostics[0]
  return Object.freeze({
    qualifiedId: id, name: plugin.manifest.name,
    ...plugin.manifest.version === undefined ? {} : { version: plugin.manifest.version },
    format: plugin.format, source, enabled: true, status,
    skillCount: plugin.skills.length, commandCount: plugin.commands.length, mcpServerCount: plugin.mcpServers.length,
    ...diagnostic === undefined ? {} : { error: sanitize(`${diagnostic.subject}: ${diagnostic.message}`, [plugin.root, plugin.dataDir]) },
  })
}

function memoryProvider(plugin: LoadedCompatiblePlugin): SkillProvider {
  const provider = `agent-plugin:${plugin.manifest.name}:${plugin.instanceHash}`
  const definitions = new Map(plugin.skills.map(skill => [skill.name, skillDefinition(skill, provider)]))
  return {
    name: provider,
    list: () => Promise.resolve(plugin.skills.map(skill => skillCandidate(skill, provider))),
    get: candidate => Promise.resolve(definitions.get(candidate.name)),
  }
}

function skillCandidate(skill: PortableSkill, provider: string): SkillCandidate {
  return {
    name: skill.name, description: skill.description,
    invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
    source: 'agent-plugin', provider, resourceBase: { kind: 'directory', path: skill.resourceBase },
    rank: BUNDLED_SKILL_RANK, locator: skill.name, path: skill.path,
    ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
  }
}

function skillDefinition(skill: PortableSkill, provider: string): SkillDefinition {
  const { rank: _rank, locator: _locator, ...definition } = skillCandidate(skill, provider)
  return { ...definition, content: skill.content }
}

function registerCommands(ctx: Context, agent: Agent, plugin: LoadedCompatiblePlugin, projectRoot: string | undefined): void {
  for (const command of plugin.commands) ctx.commands.register({
    name: command.name, description: command.description,
    ...command.argumentHint === undefined ? {} : { input: { hint: command.argumentHint } },
    handler(invocation: CommandInvocation) {
      const expanded = expandClaudeCommand(command, {
        rawInput: invocation.rawInput, sessionId: agent.id,
        ...projectRoot === undefined ? {} : { projectRoot },
        pluginRoot: plugin.root, pluginData: plugin.dataDir, commandDirectory: command.directory,
      })
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: expanded.text }],
        source: { kind: 'agent-plugin-command', plugin: plugin.qualifiedId, command: command.name },
      }))
      return { kind: 'success', text: `Queued /${command.name}.` }
    },
  })
}

async function mountMcp(ctx: Context, server: PortableMcpServer, policy: Config['mcp']): Promise<void> {
  let child: ReturnType<Context['plugin']> | undefined
  try {
    child = ctx.plugin(McpClient, McpClient.Config({
      ...server.transport === 'stdio'
        ? { transport: 'stdio' as const, serverName: server.serverName, command: server.command, args: [...server.args], env: { ...server.env }, cwd: server.cwd }
        : { transport: 'streamable-http' as const, serverName: server.serverName, url: server.url, headers: { ...server.headers } },
      failOnStartupError: false,
      ...policy?.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: policy.toolCallTimeoutMs },
      ...policy?.reconnect === undefined ? {} : { reconnect: policy.reconnect },
    } as never))
    await child
  } catch (error) {
    await child?.dispose().catch(() => {})
    ctx.logger.warn(`agent-plugins MCP ${JSON.stringify(server.rawKey)} failed to mount: ${safeError(error)}`)
  }
}

function sanitize(value: string, paths: readonly string[]): string {
  let result = value.replaceAll(/[\r\n\t]+/gu, ' ')
  for (const path of paths.toSorted((left, right) => right.length - left.length)) result = result.replaceAll(path, '<path>')
  return result.slice(0, 300)
}

function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
