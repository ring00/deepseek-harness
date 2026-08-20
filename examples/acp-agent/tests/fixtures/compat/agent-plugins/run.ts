import { cp, mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-plugins'
import type {} from '@deepseek-ai/dsh-commands'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../../../../packages/core/agent-loop/tests/mock-adapter.ts'

const configPath = process.argv[2]
const fixtureRoot = process.env.DSH_AGENT_PLUGIN_FIXTURE
const projectRoot = process.env.DSH_AGENT_PLUGIN_PROJECT
if (configPath === undefined || fixtureRoot === undefined || projectRoot === undefined) {
  throw new Error('agent-plugins snapshot requires config and fixture paths')
}

const pluginRoot = join(projectRoot, '.agents', 'plugins', 'snapshot-claude')
await mkdir(pluginRoot, { recursive: true })
await cp(fixtureRoot, pluginRoot, { recursive: true })

const ctx = await boot('agent-plugins-snapshot', resolve(configPath))
try {
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('COMMAND_QUEUED_OK')]))
  const agent = (await ctx.agents.create({
    sessionId: SessionId('agent-plugins-snapshot'),
    meta: { cwd: projectRoot },
    agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  const skill = await ctx.skills.get('snapshot-plugin-skill', { scope: agent, cwd: projectRoot })
  if (skill === undefined) throw new Error('snapshot-plugin-skill was not loaded')
  const command = await ctx.commands.execute(
    agent,
    '/snapshot-claude:check "quoted value"',
    new AbortController().signal,
  )
  if (command === undefined) throw new Error('snapshot Claude command was not registered')
  await agent.whenIdle()
  const queued = agent.session.events.find(event => event.type === 'user/message'
    && event.data.source.kind === 'agent-plugin-command')
  if (queued?.type !== 'user/message') throw new Error('snapshot Claude command prompt was not queued')

  const tool = ctx.tools.schemas(agent).find(schema => schema.description === 'Returns the assembled Claude plugin snapshot marker.')
  if (tool === undefined) throw new Error('snapshot MCP tool was not registered')
  const result = await ctx.tools.execute({
    agent,
    callId: CallId('agent-plugins-snapshot'),
    signal: new AbortController().signal,
    name: tool.name,
    arguments: {},
  })
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error(`snapshot MCP tool returned ${JSON.stringify(result.content)}`)
  const inventory = ctx.agentPlugin.list(agent).entries[0]
  const project = (await realpath(projectRoot)).replaceAll('\\', '/')
  process.stdout.write(`${JSON.stringify({
    inventory,
    skill: {
      name: skill.name,
      description: skill.description,
      content: skill.content.trim(),
      source: skill.source,
      provider: skill.provider.replace(/:[0-9a-f]{12}$/u, ':<instance>'),
    },
    command: {
      result: command.result,
      prompt: queued.data.content.map(part => part.type === 'text' ? part.text : '').join('').replaceAll(project, '<project>'),
      source: queued.data.source,
    },
    tool: {
      name: tool.name.replace(/^mcp__.+__/u, 'mcp__<instance>__'),
      result: block.text,
    },
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
