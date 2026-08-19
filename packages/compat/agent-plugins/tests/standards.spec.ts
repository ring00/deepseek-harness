import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { AGENT_SKILLS_REVISION, MCP_SCHEMA_ID, PLUGIN_SCHEMA_ID } from '@deepseek-ai/dsh-agent-plugins/portable'

const schemaRoot = new URL('../schemas/', import.meta.url)

describe('vendored compatibility standards', () => {
  it('matches the immutable Agent Plugins 1.0 schema hashes and Agent Skills revision', async () => {
    const lock = JSON.parse(await readFile(new URL('standards-lock.json', schemaRoot), 'utf8')) as {
      agentPlugins: {
        version: string
        pluginSchema: { url: string; sha256: string }
        mcpSchema: { url: string; sha256: string }
      }
      agentSkills: { revision: string }
    }
    const pluginSchema = await readFile(new URL('1.0.0/plugin.schema.json', schemaRoot))
    const mcpSchema = await readFile(new URL('1.0.0/mcp.schema.json', schemaRoot))

    expect(lock.agentPlugins).toMatchObject({
      version: '1.0.0',
      pluginSchema: { url: PLUGIN_SCHEMA_ID },
      mcpSchema: { url: MCP_SCHEMA_ID },
    })
    expect(createHash('sha256').update(pluginSchema).digest('hex')).toBe(lock.agentPlugins.pluginSchema.sha256)
    expect(createHash('sha256').update(mcpSchema).digest('hex')).toBe(lock.agentPlugins.mcpSchema.sha256)
    expect(lock.agentSkills.revision).toBe(AGENT_SKILLS_REVISION)
  })
})
