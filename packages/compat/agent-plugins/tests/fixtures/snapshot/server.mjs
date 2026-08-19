import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'agent-plugin-snapshot-fixture', version: '1.0.0' })

server.registerTool('probe', {
  description: 'Returns the assembled Agent Plugins snapshot marker.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'AGENT_PLUGIN_SNAPSHOT_MCP_OK' }],
}))

await server.connect(new StdioServerTransport())
