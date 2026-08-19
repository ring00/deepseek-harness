import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'agent-plugin-runtime-fixture', version: '1.0.0' })

server.registerTool('probe', {
  description: 'Returns a deterministic Agent Plugins compatibility marker.',
  inputSchema: { value: z.string().optional() },
}, async ({ value }) => ({
  content: [{ type: 'text', text: value ?? 'AGENT_PLUGIN_MCP_OK' }],
}))

server.registerTool('crash_once', {
  description: 'Crashes the first server generation after replying.',
  inputSchema: {},
}, async () => {
  const marker = join(process.env.PLUGIN_DATA, 'crashed')
  await writeFile(marker, '1\n')
  setTimeout(() => process.exit(17), 25)
  return { content: [{ type: 'text', text: 'crashing once' }] }
})

await server.connect(new StdioServerTransport())
