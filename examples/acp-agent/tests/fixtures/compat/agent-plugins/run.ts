import { resolve } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('agent-plugins snapshot requires a config path')

const ctx = await boot('agent-plugins-snapshot', resolve(configPath))
try {
  const skill = await ctx.skills.get('snapshot-plugin-skill')
  if (skill === undefined) throw new Error('snapshot-plugin-skill was not loaded')
  const tool = ctx.tools.schemas().find(schema => schema.description === 'Returns the assembled Agent Plugins snapshot marker.')
  if (tool === undefined) throw new Error('snapshot MCP tool was not registered')
  const result = await ctx.tools.execute({
    callId: 'agent-plugins-snapshot' as never,
    signal: new AbortController().signal,
    name: tool.name,
    arguments: {},
  })
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error(`snapshot MCP tool returned ${JSON.stringify(result.content)}`)
  process.stdout.write(`${JSON.stringify({
    skill: {
      name: skill.name,
      description: skill.description,
      content: skill.content.trim(),
      source: skill.source,
      provider: skill.provider.replace(/:[0-9a-f]{12}$/, ':<instance>'),
    },
    tool: {
      name: tool.name.replace(/^mcp__.+__/, 'mcp__<instance>__'),
      result: block.text,
    },
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
