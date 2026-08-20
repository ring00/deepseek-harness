import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandClaudeCommand, inspectCompatibleManifest, loadCompatiblePlugin } from '@deepseek-ai/dsh-agent-plugins/adapters'
import type { DiscoveredPlugin } from '@deepseek-ai/dsh-agent-plugins/discovery'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))

async function temporary(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `agent-plugin-adapter-${label}-`))
  roots.push(path)
  return path
}

async function fixture(): Promise<{ root: string; candidate: DiscoveredPlugin }> {
  const root = await temporary('claude')
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'plugin-dev', version: '1.2.3', skills: './skills', commands: './commands',
    agents: './agents', hooks: './hooks', lspServers: {}, outputStyles: './styles',
  }))
  await mkdir(join(root, 'skills', 'review'), { recursive: true })
  await writeFile(join(root, 'skills', 'review', 'SKILL.md'), [
    '---', 'name: review', 'description: Review changes.', 'user-invocable: false',
    'disable-model-invocation: true', 'allowed-tools: Bash', '---', 'Review safely.', '',
  ].join('\n'))
  await mkdir(join(root, 'commands', 'git'), { recursive: true })
  await writeFile(join(root, 'commands', 'git', 'commit.md'), [
    '---', 'description: Commit changes', 'argument-hint: <message>', 'model: ignored', '---',
    'Commit $1 for $branch in $PROJECT_ROOT. $ARGUMENTS !`git status` @./secret.txt', '',
  ].join('\n'))
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    local: { type: 'stdio', command: 'node', args: ['server.mjs', '${TOKEN}'], env: { TOKEN_COPY: '${TOKEN:-fallback}' }, env_vars: ['REQUIRED'], cwd: '${PLUGIN_DATA}' },
    remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
    missing: { type: 'http', url: 'https://example.com/${MISSING}' },
    legacy: { type: 'sse', url: 'https://example.com/sse' },
  } }))
  return {
    root,
    candidate: {
      qualifiedId: 'configured:test:plugin-dev', dataIdentity: 'configured:test:plugin-dev',
      sourceId: 'configured:test', sourceLabel: 'test', format: 'claude', root, diagnostics: [],
    },
  }
}

describe('Claude adapter', () => {
  it('inspects disabled plugins without parsing their components', async () => {
    const { root, candidate } = await fixture()
    await writeFile(join(root, '.mcp.json'), '{ invalid')
    await writeFile(join(root, 'skills', 'review', 'SKILL.md'), 'invalid skill')

    await expect(inspectCompatibleManifest(candidate)).resolves.toEqual({ name: 'plugin-dev', version: '1.2.3' })
  })

  it('loads skills, namespaced commands, setup-time credentials, and isolated MCP entries', async () => {
    const { candidate } = await fixture()
    const dataRoot = await temporary('data')
    const secrets: Record<string, string> = { TOKEN: 'first-secret', REQUIRED: 'required-secret' }
    const loaded = await loadCompatiblePlugin(candidate, {
      dataRoot,
      resolveExecutable: command => Promise.resolve(`/resolved/${command}`),
      resolveCredential: name => Promise.resolve(secrets[name]),
    })

    expect(loaded.manifest).toEqual({ name: 'plugin-dev', version: '1.2.3' })
    expect(loaded.skills[0]).toMatchObject({
      name: 'review', invocation: { modelInvocable: false, userInvocable: false },
      metadata: { 'agentskills.io': { 'allowed-tools': 'Bash' }, 'claude-code': expect.any(Object) as unknown },
    })
    expect(loaded.commands.map(command => command.name)).toEqual(['plugin-dev:git:commit'])
    expect(loaded.unsupportedComponents).toEqual(['agents', 'hooks', 'lspServers', 'outputStyles'])
    expect(loaded.mcpServers).toHaveLength(2)
    expect(loaded.mcpServers[0]).toMatchObject({
      transport: 'stdio', command: '/resolved/node', args: ['server.mjs', 'first-secret'],
      env: { TOKEN_COPY: 'first-secret', REQUIRED: 'required-secret', PLUGIN_ROOT: loaded.root, CLAUDE_PLUGIN_ROOT: loaded.root },
    })
    expect(loaded.mcpServers[1]).toMatchObject({
      transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer first-secret' },
    })
    expect(loaded.diagnostics.map(diagnostic => diagnostic.subject)).toEqual(expect.arrayContaining(['mcp:missing', 'mcp:legacy', 'component:agents']))

    secrets.TOKEN = 'rotated-secret'
    const reloaded = await loadCompatiblePlugin(candidate, {
      dataRoot, resolveExecutable: command => Promise.resolve(`/resolved/${command}`), resolveCredential: name => Promise.resolve(secrets[name]),
    })
    expect(loaded.mcpServers[0]).toMatchObject({ args: ['server.mjs', 'first-secret'] })
    expect(reloaded.mcpServers[0]).toMatchObject({ args: ['server.mjs', 'rotated-secret'] })
  })

  it('expands arguments and paths once while making dynamic context model-visible', async () => {
    const { root, candidate } = await fixture()
    const loaded = await loadCompatiblePlugin(candidate, {
      dataRoot: await temporary('data'), resolveExecutable: command => Promise.resolve(command),
      resolveCredential: name => Promise.resolve(name === 'REQUIRED' ? 'required' : name === 'TOKEN' ? 'token' : undefined),
    })
    const command = loaded.commands[0]
    if (command === undefined) throw new Error('command fixture missing')
    const expanded = expandClaudeCommand(command, {
      rawInput: '"release one" branch=main', sessionId: 'session-1', projectRoot: '/project',
      pluginRoot: root, pluginData: loaded.dataDir, commandDirectory: join(root, 'commands', 'git'),
    })
    expect(expanded.partial).toBe(true)
    expect(expanded.text).toContain('Commit release one for main in /project.')
    expect(expanded.text).toContain('[Claude dynamic command omitted;')
    expect(expanded.text).toContain('[Claude file injection omitted;')
    expect(expanded.text).not.toContain('git status')
  })

  it('appends raw arguments when the template omits $ARGUMENTS and rejects unclosed quotes', () => {
    const command = { name: 'p:c', description: 'c', template: 'Do $1.', directory: '/c', partial: false }
    expect(expandClaudeCommand(command, {
      rawInput: 'one two', sessionId: 's', pluginRoot: '/p', pluginData: '/d', commandDirectory: '/c',
    }).text).toBe('Do one.\n\none two\n')
    expect(() => expandClaudeCommand(command, {
      rawInput: '"open', sessionId: 's', pluginRoot: '/p', pluginData: '/d', commandDirectory: '/c',
    })).toThrow(/unclosed quote/u)
  })
})
