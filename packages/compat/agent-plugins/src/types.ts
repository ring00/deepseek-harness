import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable source-qualified identity of one discovered plugin installation. */
export type AgentPluginQualifiedId = Branded<'AgentPluginQualifiedId'>
/** Manifest dialect selected for compatibility. */
export type AgentPluginFormat = 'agent-plugins' | 'claude'
/** Outcome of one enabled candidate's mounting attempt. */
export type AgentPluginStatus = 'loaded' | 'partial' | 'failed'

/** Path-free, secret-free status for one enabled plugin candidate. */
export interface AgentPluginEntry {
  readonly qualifiedId: AgentPluginQualifiedId
  readonly name: string
  readonly version?: string
  readonly format: AgentPluginFormat
  readonly source: string
  readonly status: AgentPluginStatus
  readonly skillCount: number
  readonly commandCount: number
  readonly mcpServerCount: number
  readonly error?: string
}

/** Point-in-time inventory for one live agent generation. */
export interface AgentPluginSnapshot {
  readonly entries: readonly AgentPluginEntry[]
}
