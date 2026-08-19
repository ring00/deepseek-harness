/**
 * Cordis adapter for one Agent Plugins 1.0 directory.
 *
 * Each row owns one immutable in-memory skill provider and one child
 * `dsh-mcp-client` fiber per valid MCP server. Cordis disposal removes the
 * provider and every child; Loader HMR replaces the complete row.
 *
 * @module @deepseek-ai/dsh-agent-plugins
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { loadAgentPlugin, type LoadedAgentPlugin, type PortableMcpServer, type PortableSkill } from './portable.ts'

export * from './portable.ts'

/** Agent Plugins compatibility configuration for one plugin root. */
export interface Config {
  /** Required absolute path to one Agent Plugin directory. */
  readonly root: string
  /** Persistent writable directory for this instance. */
  readonly dataDir?: string
  /** MCP client policy applied to every translated server in this row. */
  readonly mcp?: {
    /** Per-tool-call timeout passed to the official MCP client. */
    readonly toolCallTimeoutMs?: number
    /** Reconnect policy passed to the official MCP client. */
    readonly reconnect?: ReconnectConfig
  }
}

const Reconnect: Schema<ReconnectConfig> = z.object({
  enabled: z.boolean(),
  initialDelayMs: z.number().min(1),
  maxDelayMs: z.number().min(1),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

/** Loader configuration schema. */
export const Config: Schema<Config> = z.object({
  root: z.string().required(),
  dataDir: z.string(),
  mcp: z.object({
    toolCallTimeoutMs: z.number().min(1),
    reconnect: Reconnect,
  }),
})

/** Cordis plugin name. */
export const name = 'agent-plugins'
/** Services required by the skill provider and child MCP clients. */
export const inject = ['skills', 'tools']

/**
 * Validate and mount one Agent Plugin directory.
 * @param ctx - Cordis context carrying DSH skills and tools.
 * @param config - one-root compatibility configuration.
 * @returns activation readiness after portable discovery completes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const parentEnv = scrubbedParentEnv()
  const loaded = await loadAgentPlugin(config.root, {
    ...config.dataDir === undefined ? {} : { dataDir: config.dataDir },
    defaultDataRoot: join(resolveDshHome(), 'agent-plugins', 'data'),
    basePath: parentEnv.PATH,
    report: (diagnostic) => {
      ctx.logger.warn(`agent-plugins(${config.root}): ${diagnostic.subject}: ${diagnostic.message}`)
    },
  })
  ctx.skills.registerProvider(() => memoryProvider(loaded))
  await Promise.all(loaded.mcpServers.map(server => mountMcpChild(ctx, server, config.mcp)))
}

function memoryProvider(plugin: LoadedAgentPlugin): SkillProvider {
  const providerName = `agent-plugin:${plugin.manifest.name}:${plugin.instanceHash}`
  const definitions = new Map(plugin.skills.map(skill => [skill.name, skillDefinition(skill, providerName)]))
  const candidates = plugin.skills.map(skill => skillCandidate(skill, providerName))
  return {
    name: providerName,
    list: () => Promise.resolve(candidates),
    get: candidate => Promise.resolve(definitions.get(candidate.name)),
  }
}

function skillCandidate(skill: PortableSkill, provider: string): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'agent-plugin',
    provider,
    resourceBase: { kind: 'directory', path: skill.resourceBase },
    rank: BUNDLED_SKILL_RANK,
    locator: skill.name,
    path: skill.path,
    ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
  }
}

function skillDefinition(skill: PortableSkill, provider: string): SkillDefinition {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'agent-plugin',
    provider,
    resourceBase: { kind: 'directory', path: skill.resourceBase },
    path: skill.path,
    ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
  }
}

async function mountMcpChild(
  ctx: Context,
  server: PortableMcpServer,
  policy: Config['mcp'],
): Promise<void> {
  await ctx.effect(async () => {
    let child: ReturnType<Context['plugin']> | undefined
    try {
      const nativeConfig = McpClient.Config({
        ...server.transport === 'stdio'
          ? {
            transport: 'stdio' as const,
            serverName: server.serverName,
            command: server.command,
            args: [...server.args],
            env: { ...server.env },
            cwd: server.cwd,
          }
          : {
            transport: 'streamable-http' as const,
            serverName: server.serverName,
            url: server.url,
            headers: { ...server.headers },
          },
        ...policy?.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: policy.toolCallTimeoutMs },
        failOnStartupError: false,
        ...policy?.reconnect === undefined ? {} : { reconnect: policy.reconnect },
      } as never)
      child = ctx.plugin(McpClient, nativeConfig)
      await child
    } catch (error) {
      /* v8 ignore next -- Cordis already rolls back a rejected child; this suppresses only a second disposal failure. */
      await child?.dispose().catch(() => {})
      ctx.logger.warn(`agent-plugins MCP server ${JSON.stringify(server.rawKey)} failed to mount: ${errorMessage(error)}`)
      return () => {}
    }
    return () => child.dispose()
  }, `agent-plugins.mcp(${JSON.stringify(server.rawKey)})`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
