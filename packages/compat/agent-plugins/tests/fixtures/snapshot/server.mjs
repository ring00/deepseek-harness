import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'claude-plugin-snapshot-fixture', version: '1.0.0' },
    }
  } else if (request.method === 'tools/list') {
    result = {
      tools: [{
        name: 'probe',
        description: 'Returns the assembled Claude plugin snapshot marker.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
    }
  } else if (request.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'AGENT_PLUGIN_SNAPSHOT_MCP_OK' }] }
  } else if (request.method === 'ping') {
    result = {}
  } else {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    })}\n`)
    continue
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
}
