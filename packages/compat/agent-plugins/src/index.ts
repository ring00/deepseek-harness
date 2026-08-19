/** Per-agent Agent Plugins and Claude Code compatibility service. */

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
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { expandClaudeCommand, loadCompatiblePlugin, type LoadedCompatiblePlugin } from './adapters.ts'
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
    /** Built-in source families; defaults to DSH and Claude, while an empty list disables both. */
    defaults?: BuiltinSource[]
    /** Absolute home-directory overrides for built-in DSH or Claude sources. */
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
    defaults: z.array(z.union(['dsh', 'claude'] as const)),
    homes: z.object({ dsh: z.string(), claude: z.string() }),
    sources: z.array(Source),
  }),
  dataRoot: z.string(),
  mcp: z.object({ toolCallTimeoutMs: z.number().min(1), reconnect: Reconnect }),
})

export const name = 'agent-plugins'
export const inject = ['agents', 'skills', 'tools', 'commands', 'credentials']

/** Durable source for a queued legacy Claude command prompt. */
export interface AgentPluginCommandMessageSource {
  readonly kind: 'agent-plugin-command'
  readonly plugin: string
  readonly command: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'agent-plugin-command': AgentPluginCommandMessageSource }
}

const EMPTY: AgentPluginSnapshot = Object.freeze({ entries: Object.freeze([]) })

/** Immutable compatibility inventory for each live agent generation. */
export class AgentPluginInventory extends TypertRemoteService {
  private readonly generations = new Map<Agent, AgentPluginSnapshot>()
  constructor(ctx: Context) { super(ctx, 'agentPlugin') }
  /**
   * Publish one generation immediately before its agent becomes visible.
   * @param agent - exact agent that owns the generation.
   * @param snapshot - immutable inventory to publish.
   */
  set(agent: Agent, snapshot: AgentPluginSnapshot): void { this.generations.set(agent, snapshot) }
  /**
   * Remove one exact generation during row or agent teardown.
   * @param agent - exact agent that owned the generation.
   * @param snapshot - exact snapshot being disposed.
   */
  remove(agent: Agent, snapshot: AgentPluginSnapshot): void {
    if (this.generations.get(agent) === snapshot) this.generations.delete(agent)
  }
  /**
   * Read the selected live agent's current generation.
   * @param agent - selected live agent.
   * @returns its inventory or an empty snapshot.
   */
  @Remote('list')
  list(agent: Agent): AgentPluginSnapshot { return this.generations.get(agent) ?? EMPTY }
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
  const inventory = new AgentPluginInventory(ctx)
  const dataRoot = config.dataRoot ?? join(resolveDshHome(), 'agent-plugins', 'data')
  const generations = new Map<Agent, Fiber>()
  const unregister = ctx.agents.registerSetup(async (agentCtx, signal) => {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('agent-plugins setup context has no agent')
    let snapshot: AgentPluginSnapshot | undefined
    const fiber = agentCtx.plugin({
      name: 'agent-plugin-generation', inject,
      async apply(generationCtx: Context): Promise<void> {
        generationCtx.effect(() => () => { generations.delete(agent) }, 'agent-plugins.generation')
        snapshot = await loadGeneration(generationCtx, agent, config, dataRoot)
        const owned = snapshot
        generationCtx.effect(() => () => { inventory.remove(agent, owned) }, 'agent-plugins.inventory')
      },
    })
    generations.set(agent, fiber)
    try {
      await fiber
      if (signal.aborted) throw signal.reason
      if (snapshot === undefined) throw new Error('agent-plugin generation produced no inventory')
      const prepared = snapshot
      return { commit: () => { if (signal.aborted) throw signal.reason; inventory.set(agent, prepared) } }
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

async function loadGeneration(ctx: Context, agent: Agent, config: Config, dataRoot: string): Promise<AgentPluginSnapshot> {
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
  for (const candidate of discovery.plugins) {
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
        qualifiedId: candidate.qualifiedId as AgentPluginQualifiedId,
        name: candidate.qualifiedId.slice(candidate.qualifiedId.lastIndexOf(':') + 1),
        format: candidate.format, source: candidate.sourceLabel,
        status: 'failed', skillCount: 0, commandCount: 0, mcpServerCount: 0,
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
        candidate.qualifiedId as AgentPluginQualifiedId,
        candidate.sourceLabel,
        loaded,
        partial ? 'partial' : 'loaded',
      ))
    } catch (error) {
      entries.push({
        ...entry(candidate.qualifiedId as AgentPluginQualifiedId, candidate.sourceLabel, loaded, 'failed'),
        error: sanitize(safeError(error), [loaded.root, loaded.dataDir]),
      })
    }
  }
  return Object.freeze({ entries: Object.freeze(entries) })
}

function entry(id: AgentPluginQualifiedId, source: string, plugin: LoadedCompatiblePlugin, status: AgentPluginEntry['status']): AgentPluginEntry {
  const diagnostic = plugin.diagnostics[0]
  return Object.freeze({
    qualifiedId: id, name: plugin.manifest.name,
    ...plugin.manifest.version === undefined ? {} : { version: plugin.manifest.version },
    format: plugin.format, source, status,
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
