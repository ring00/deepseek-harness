import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentPluginLoadError,
  MCP_SCHEMA_ID,
  PLUGIN_SCHEMA_ID,
  expandPluginVariables,
  loadAgentPlugin,
  serverNamespace,
} from '@deepseek-ai/dsh-agent-plugins/portable'

const completeFixture = fileURLToPath(new URL('./fixtures/complete/', import.meta.url))
const temporaryRoots: string[] = []
const basePath = dirname(process.execPath)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-agent-plugins-${label}-`))
  temporaryRoots.push(path)
  return path
}

async function createPlugin(label: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const root = await temporaryDirectory(label)
  await writeFile(join(root, 'plugin.json'), JSON.stringify({
    $schema: PLUGIN_SCHEMA_ID,
    name: `test-${label}`.replaceAll(/[^a-z0-9-]/g, '-'),
    ...manifest,
  }))
  return root
}

async function load(root: string, options: {
  dataDir?: string
  platform?: NodeJS.Platform
  report?: (subject: string, message: string) => void
  resolveExecutable?: (command: string, basePath: string | undefined) => Promise<string>
  withoutBasePath?: boolean
} = {}) {
  const defaultDataRoot = await temporaryDirectory('data')
  const report = options.report
  return loadAgentPlugin(root, {
    defaultDataRoot,
    ...options.withoutBasePath === true ? {} : { basePath },
    ...options.dataDir === undefined ? {} : { dataDir: options.dataDir },
    ...options.platform === undefined ? {} : { platform: options.platform },
    ...report === undefined
      ? {}
      : { report: (diagnostic) => { report(diagnostic.subject, diagnostic.message) } },
    ...options.resolveExecutable === undefined ? {} : { resolveExecutable: options.resolveExecutable },
  })
}

describe('portable Agent Plugins loader', () => {
  it('loads the pinned schema, manifest exceptions, Agent Skill metadata, and supported MCP entries', async () => {
    const plugin = await load(completeFixture)

    expect(plugin.manifest.name).toBe('fixture.plugin')
    expect(plugin.instanceHash).toMatch(/^[0-9a-f]{12}$/)
    expect(basename(plugin.dataDir)).toBe(`fixture.plugin-${plugin.instanceHash}`)
    expect(plugin.manifest.extensions).toEqual({
      'com.example.unimplemented': 'contents are intentionally not validated',
    })
    expect(plugin.diagnostics.map(value => value.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('unknown field "futureField" ignored'),
      expect.stringContaining('must match directory'),
      expect.stringContaining('legacy sse transport is unsupported'),
      expect.stringContaining('invalid server entry'),
    ]))

    expect(plugin.skills).toHaveLength(1)
    expect(plugin.skills[0]).toMatchObject({
      name: 'fixture-skill',
      metadata: {
        'agentskills.io': {
          license: 'MIT',
          compatibility: 'Requires a local Node.js runtime.',
          metadata: { author: 'dsh-tests', revision: '1' },
          'allowed-tools': 'Bash(node:*) Read',
        },
      },
    })
    expect(plugin.skills[0]?.content).toContain('AGENT_PLUGIN_SKILL_OK')

    expect(plugin.mcpServers).toHaveLength(2)
    const stdio = plugin.mcpServers.find(server => server.transport === 'stdio')
    expect(stdio).toMatchObject({
      command: process.execPath,
      cwd: plugin.dataDir,
      env: {
        PLUGIN_ROOT: plugin.root,
        PLUGIN_DATA: plugin.dataDir,
        ROOT_VALUE: plugin.root,
        DATA_VALUE: plugin.dataDir,
      },
    })
    if (stdio?.transport !== 'stdio') throw new Error('expected stdio fixture')
    expect(stdio.args).toEqual([
      `${plugin.root}/server.mjs`,
      `${plugin.dataDir}/state`,
      '${UNRECOGNIZED}',
    ])
  })

  it('preserves explicit dataDir state across loads and installation moves', async () => {
    const explicitData = await temporaryDirectory('persistent')
    const firstRoot = await createPlugin('move-one')
    const first = await load(firstRoot, { dataDir: explicitData })
    await writeFile(join(first.dataDir, 'state.txt'), 'preserved\n')
    const secondRoot = await createPlugin('move-two', { name: 'test-move-one' })
    const second = await load(secondRoot, { dataDir: explicitData })

    expect(second.dataDir).toBe(first.dataDir)
    expect(await readFile(join(second.dataDir, 'state.txt'), 'utf8')).toBe('preserved\n')
    expect(second.instanceHash).not.toBe(first.instanceHash)
  })

  it('fails the complete row for relative roots, relative data paths, and invalid manifests', async () => {
    const root = await createPlugin('fatal')
    await expect(loadAgentPlugin('relative', { defaultDataRoot: await temporaryDirectory('fatal-data') }))
      .rejects.toThrow(AgentPluginLoadError)
    await expect(loadAgentPlugin(root, { defaultDataRoot: 'relative' })).rejects.toThrow('defaultDataRoot')
    await expect(loadAgentPlugin(root, { defaultDataRoot: await temporaryDirectory('fatal-data'), dataDir: 'relative' }))
      .rejects.toThrow('dataDir')

    await writeFile(join(root, 'plugin.json'), JSON.stringify({ $schema: 'https://example.test/future.json', name: 'fatal' }))
    await expect(load(root)).rejects.toThrow(/invalid plugin\.json/)
    await writeFile(join(root, 'plugin.json'), '[]')
    await expect(load(root)).rejects.toThrow(/plugin\.json must be an object/)
    await writeFile(join(root, 'plugin.json'), '{')
    await expect(load(root)).rejects.toThrow(SyntaxError)
  })

  it('reports and ignores a non-object extensions value', async () => {
    const root = await createPlugin('extensions', { extensions: 'future', extra: true })
    const reports: string[] = []
    const plugin = await load(root, { report: (subject, message) => reports.push(`${subject}: ${message}`) })

    expect(plugin.manifest.extensions).toBeUndefined()
    expect(reports).toEqual([
      'plugin.json: unknown field "extra" ignored',
      'plugin.json: non-object extensions field ignored',
    ])
  })

  it('rejects file-valued roots, data directories, and required files', async () => {
    const rootFile = join(await temporaryDirectory('root-file'), 'plugin')
    await writeFile(rootFile, 'not a directory')
    await expect(load(rootFile)).rejects.toThrow('agent plugin root is not a directory')

    const root = await createPlugin('data-file')
    const dataFile = join(await temporaryDirectory('data-file-parent'), 'data')
    await writeFile(dataFile, 'not a directory')
    await expect(load(root, { dataDir: dataFile })).rejects.toThrow(/EEXIST|not a directory/)

    const manifestDirectory = await temporaryDirectory('manifest-directory')
    await mkdir(join(manifestDirectory, 'plugin.json'))
    await expect(load(manifestDirectory)).rejects.toThrow('plugin.json is not a regular file')
  })

  it('disables only a wrong-kind fixed component location', async () => {
    const root = await createPlugin('wrong-kind')
    await writeFile(join(root, 'skills'), 'not a directory')
    await mkdir(join(root, 'mcp.json'))
    const plugin = await load(root)

    expect(plugin.skills).toEqual([])
    expect(plugin.mcpServers).toEqual([])
    expect(plugin.diagnostics.map(value => value.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('skills is not a directory'),
      expect.stringContaining('mcp.json is not a file'),
    ]))
  })

  it('enforces containment after symlink resolution for fixed locations and discovered skills', async () => {
    const root = await createPlugin('escape')
    const outside = await temporaryDirectory('outside')
    await writeFile(join(outside, 'mcp.json'), JSON.stringify({ $schema: MCP_SCHEMA_ID, mcpServers: {} }))
    await mkdir(join(outside, 'skill'))
    await writeFile(join(outside, 'skill', 'SKILL.md'), '---\nname: escaped\ndescription: Escaped.\n---\nbody\n')
    await mkdir(join(root, 'skills'))
    await symlink(join(outside, 'skill'), join(root, 'skills', 'escaped'))
    await symlink(join(outside, 'mcp.json'), join(root, 'mcp.json'))
    const plugin = await load(root)

    expect(plugin.skills).toEqual([])
    expect(plugin.mcpServers).toEqual([])
    expect(plugin.diagnostics.map(value => value.message).join('\n')).toContain('outside the plugin root')
  })

  it('skips invalid skills independently and accepts only immediate SKILL.md entries', async () => {
    const root = await createPlugin('skills')
    await mkdir(join(root, 'skills', 'valid'), { recursive: true })
    await writeFile(join(root, 'skills', 'valid', 'SKILL.md'), '---\nname: valid\ndescription: Valid skill.\n---\nbody\n')
    await mkdir(join(root, 'skills', 'extra'), { recursive: true })
    await writeFile(join(root, 'skills', 'extra', 'SKILL.md'), '---\nname: extra\ndescription: Extra.\nunknown: true\n---\nbody\n')
    await mkdir(join(root, 'skills', 'bad-metadata'), { recursive: true })
    await writeFile(join(root, 'skills', 'bad-metadata', 'SKILL.md'), '---\nname: bad-metadata\ndescription: Bad metadata.\nmetadata:\n  count: 2\n---\nbody\n')
    await mkdir(join(root, 'skills', 'nested', 'deeper'), { recursive: true })
    await writeFile(join(root, 'skills', 'nested', 'deeper', 'SKILL.md'), '---\nname: deeper\ndescription: Too deep.\n---\nbody\n')
    const plugin = await load(root)

    expect(plugin.skills.map(skill => skill.name)).toEqual(['valid'])
    expect(plugin.diagnostics).toHaveLength(2)
  })

  it('isolates malformed skills and filesystem resolution failures', async () => {
    const root = await createPlugin('skill-edges')
    const skillsRoot = join(root, 'skills')
    await mkdir(skillsRoot)
    const outside = await temporaryDirectory('skill-file-outside')
    await writeFile(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: Outside.\n---\nbody\n')
    await mkdir(join(skillsRoot, 'outside'))
    await symlink(join(outside, 'SKILL.md'), join(skillsRoot, 'outside', 'SKILL.md'))
    await symlink(join(skillsRoot, 'loop'), join(skillsRoot, 'loop'))
    await symlink(join(skillsRoot, 'absent'), join(skillsRoot, 'dangling'))

    const cases: Record<string, string> = {
      'no-frontmatter': 'body only\n',
      bad_name: '---\nname: bad_name\ndescription: Invalid name.\n---\nbody\n',
      'long-description': `---\nname: long-description\ndescription: ${'d'.repeat(1025)}\n---\nbody\n`,
      'long-compatibility': `---\nname: long-compatibility\ndescription: Long compatibility.\ncompatibility: ${'c'.repeat(501)}\n---\nbody\n`,
      'missing-description': '---\nname: missing-description\n---\nbody\n',
      'empty-description': '---\nname: empty-description\ndescription: ""\n---\nbody\n',
      'null-frontmatter': '---\nnull\n---\nbody\n',
      'null-metadata': '---\nname: null-metadata\ndescription: Null metadata.\nmetadata: null\n---\nbody\n',
      'numeric-metadata': '---\nname: numeric-metadata\ndescription: Numeric metadata.\nmetadata:\n  revision: 1\n---\nbody\n',
    }
    for (const [name, content] of Object.entries(cases)) {
      await mkdir(join(skillsRoot, name))
      await writeFile(join(skillsRoot, name, 'SKILL.md'), content)
    }

    const plugin = await load(root)
    expect(plugin.skills).toEqual([])
    expect(plugin.diagnostics).toHaveLength(Object.keys(cases).length + 2)
    expect(plugin.diagnostics.map(value => value.message).join('\n')).toContain('closed YAML frontmatter')
    expect(plugin.diagnostics.map(value => value.message).join('\n')).toContain('outside the plugin root')
  })

  it('disables MCP on invalid top-level data or a schema-version mismatch without losing skills', async () => {
    const root = await createPlugin('mcp-top')
    await mkdir(join(root, 'skills', 'valid'), { recursive: true })
    await writeFile(join(root, 'skills', 'valid', 'SKILL.md'), '---\nname: valid\ndescription: Valid skill.\n---\nbody\n')
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ $schema: MCP_SCHEMA_ID, mcpServers: {}, extra: true }))
    const invalidTop = await load(root)
    expect(invalidTop.skills).toHaveLength(1)
    expect(invalidTop.mcpServers).toEqual([])

    await writeFile(join(root, 'mcp.json'), JSON.stringify({ $schema: 'https://example.test/mcp.json', mcpServers: {} }))
    const mismatch = await load(root)
    expect(mismatch.skills).toHaveLength(1)
    expect(mismatch.mcpServers).toEqual([])
    expect(mismatch.diagnostics[0]?.message).toContain('invalid top-level fields')

    await writeFile(join(root, 'mcp.json'), '{')
    const malformed = await load(root)
    expect(malformed.skills).toHaveLength(1)
    expect(malformed.mcpServers).toEqual([])
    expect(malformed.diagnostics[0]?.message).toContain('JSON')
  })

  it('isolates stdio command, cwd, reserved environment, and placeholder failures', async () => {
    const root = await createPlugin('stdio')
    const outside = await temporaryDirectory('command-outside')
    await writeFile(join(outside, 'server'), 'fixture')
    await symlink(join(outside, 'server'), join(root, 'server'))
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: MCP_SCHEMA_ID,
      mcpServers: {
        valid: {
          type: 'stdio',
          command: 'node',
          args: ['${PLUGIN_ROOT}/${PLUGIN_DATA}', '${OTHER}'],
          env: { LITERAL: '${OTHER}' },
        },
        escape: { type: 'stdio', command: './server' },
        reserved: { type: 'stdio', command: 'node', env: { plugin_root: 'bad' } },
        cwd: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/../outside' },
        'cwd-form': { type: 'stdio', command: 'node', cwd: 'relative' },
        'cwd-file-ancestor': { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/plugin.json/child' },
        'command-form': { type: 'stdio', command: 'bin/node' },
        missing: { type: 'stdio', command: 'definitely-not-on-the-test-path' },
      },
    }))
    const plugin = await load(root, { platform: 'win32' })

    expect(plugin.mcpServers).toHaveLength(1)
    const valid = plugin.mcpServers[0]
    if (valid?.transport !== 'stdio') throw new Error('expected stdio server')
    expect(valid.args).toEqual([`${plugin.root}/${plugin.dataDir}`, '${OTHER}'])
    expect(valid.env.LITERAL).toBe('${OTHER}')
    expect(plugin.diagnostics).toHaveLength(7)

    const posix = await load(root, { platform: 'linux' })
    const lowerCaseReserved = posix.mcpServers.find(server => server.rawKey === 'reserved')
    if (lowerCaseReserved?.transport !== 'stdio') throw new Error('expected POSIX lowercase environment fixture')
    expect(lowerCaseReserved.env).toMatchObject({
      plugin_root: 'bad',
      PLUGIN_ROOT: posix.root,
      PLUGIN_DATA: posix.dataDir,
    })
  })

  it('resolves dot-relative cwd paths, loop failures, the ambient PATH, and non-Error resolver failures', async () => {
    const root = await createPlugin('stdio-edges')
    await symlink(join(root, 'loop'), join(root, 'loop'))
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: MCP_SCHEMA_ID,
      mcpServers: {
        dot: { type: 'stdio', command: 'node', cwd: './missing/leaf' },
        root: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}' },
        data: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}' },
        'data-child': { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/nested' },
        loop: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/loop' },
      },
    }))
    const plugin = await load(root, { withoutBasePath: true })

    expect(plugin.mcpServers.map(server => server.rawKey)).toEqual(['dot', 'root', 'data', 'data-child'])
    expect(plugin.mcpServers.find(server => server.rawKey === 'dot')).toMatchObject({ cwd: join(plugin.root, 'missing', 'leaf') })
    expect(plugin.diagnostics).toHaveLength(1)

    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: MCP_SCHEMA_ID,
      mcpServers: { failure: { type: 'stdio', command: 'custom' } },
    }))
    const failed = await load(root, {
      resolveExecutable: () => {
        const resolver = Promise.withResolvers<string>()
        queueMicrotask(() => { resolver.reject('resolver failed') })
        return resolver.promise
      },
    })
    expect(failed.mcpServers).toEqual([])
    expect(failed.diagnostics[0]?.message).toBe('resolver failed')
  })

  it('enforces Streamable HTTP URL and header rules without expansion', async () => {
    const root = await createPlugin('http')
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: MCP_SCHEMA_ID,
      mcpServers: {
        valid: { type: 'streamable-http', url: 'http://127.0.0.1:3000/mcp', headers: { 'X-Literal': '${PLUGIN_ROOT}' } },
        duplicate: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Header: 'a', header: 'b' } },
        credentials: { type: 'streamable-http', url: 'https://user:pass@example.com/mcp' },
        fragment: { type: 'streamable-http', url: 'https://example.com/mcp#fragment' },
        insecure: { type: 'streamable-http', url: 'http://example.com/mcp' },
        protocol: { type: 'streamable-http', url: 'file:///tmp/mcp' },
        malformed: { type: 'streamable-http', url: 'not a URL' },
        'bad-header-name': { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'Bad Header': 'x' } },
        'bad-header-value': { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Header: 'bad\nvalue' } },
      },
    }))
    const plugin = await load(root)

    expect(plugin.mcpServers).toHaveLength(1)
    expect(plugin.mcpServers[0]).toMatchObject({
      transport: 'streamable-http',
      url: 'http://127.0.0.1:3000/mcp',
      headers: { 'X-Literal': '${PLUGIN_ROOT}' },
    })
    expect(plugin.diagnostics).toHaveLength(8)
  })

  it('accepts headerless HTTPS and every loopback URL form', async () => {
    const root = await createPlugin('http-loopback')
    await writeFile(join(root, 'mcp.json'), JSON.stringify({
      $schema: MCP_SCHEMA_ID,
      mcpServers: {
        https: { type: 'streamable-http', url: 'https://example.com/mcp' },
        localhost: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
        ipv6: { type: 'streamable-http', url: 'http://[::1]:3000/mcp' },
      },
    }))
    const plugin = await load(root)

    expect(plugin.mcpServers).toHaveLength(3)
    expect(plugin.mcpServers.every(server => server.transport === 'streamable-http')).toBe(true)
    expect(plugin.mcpServers.map(server => server.transport === 'streamable-http' ? server.headers : null))
      .toEqual([{}, {}, {}])
  })
})

describe('portable derivations', () => {
  it('expands supported variables once and leaves unknown text literal', () => {
    expect(expandPluginVariables('${PLUGIN_ROOT}/${PLUGIN_DATA}/${OTHER}', '/root/${PLUGIN_DATA}', '/data'))
      .toBe('/root/${PLUGIN_DATA}//data/${OTHER}')
  })

  it('derives stable bounded namespaces from the raw server key and instance identity', () => {
    const first = serverNamespace('plugin.with.a.very.long.name', 'server key/with spaces', '111111111111')
    const same = serverNamespace('plugin.with.a.very.long.name', 'server key/with spaces', '111111111111')
    const moved = serverNamespace('plugin.with.a.very.long.name', 'server key/with spaces', '222222222222')

    expect(first).toBe(same)
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(first).toHaveLength(32)
    expect(moved).not.toBe(first)
    expect(serverNamespace('!!!', '???', '111111111111')).toMatch(/^server_[0-9a-f]{12}$/)
  })
})
