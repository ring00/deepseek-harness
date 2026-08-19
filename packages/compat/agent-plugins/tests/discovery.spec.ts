import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPlugins, findProjectRoot } from '@deepseek-ai/dsh-agent-plugins/discovery'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))))

async function temporary(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `agent-plugin-discovery-${label}-`))
  roots.push(path)
  return path
}

async function manifest(root: string, format: 'agent-plugins' | 'claude', name: string): Promise<void> {
  const directory = format === 'claude' ? join(root, '.claude-plugin') : root
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'plugin.json'), JSON.stringify(format === 'claude' ? { name } : {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name,
  }))
}

describe('reduced plugin discovery', () => {
  it('orders configured, project, and user sources and deduplicates canonical roots', async () => {
    const project = await temporary('project')
    const cwd = join(project, 'nested')
    const dshHome = await temporary('dsh-home')
    const configured = await temporary('configured')
    await mkdir(join(project, '.git'))
    await mkdir(cwd)
    await manifest(configured, 'agent-plugins', 'configured')
    await mkdir(join(project, '.dsh', 'plugins'), { recursive: true })
    await symlink(configured, join(project, '.dsh', 'plugins', 'duplicate'))
    await manifest(join(project, '.claude', 'plugins', 'project-claude'), 'claude', 'project-claude')
    await manifest(join(dshHome, 'plugins', 'user-dsh'), 'agent-plugins', 'user-dsh')

    const discovered = await discoverPlugins({
      cwd, dshHome,
      discovery: { sources: [{ id: 'configured', path: configured, base: 'absolute', layout: 'plugin' }] },
      claudeHome: await temporary('empty-claude'),
    })

    expect(await findProjectRoot(cwd)).toBe(await realpath(project))
    expect(discovered.plugins.map(plugin => plugin.sourceId)).toEqual(['configured:configured', 'project:claude', 'user:dsh'])
    expect(discovered.plugins.map(plugin => plugin.format)).toEqual(['agent-plugins', 'claude', 'agent-plugins'])
  })

  it('prefers Agent Plugins when both manifests exist and honors a forced format', async () => {
    const root = await temporary('both')
    const dshHome = await temporary('home')
    await manifest(root, 'agent-plugins', 'strict')
    await manifest(root, 'claude', 'claude')
    const automatic = await discoverPlugins({
      dshHome, discovery: { defaults: [], sources: [{ id: 'both', path: root, layout: 'plugin' }] },
    })
    const forced = await discoverPlugins({
      dshHome, discovery: { defaults: [], sources: [{ id: 'both', path: root, layout: 'plugin', format: 'claude' }] },
    })
    expect(automatic.plugins[0]).toMatchObject({ format: 'agent-plugins', diagnostics: ['ignored additional manifests: claude'] })
    expect(forced.plugins[0]).toMatchObject({ format: 'claude', diagnostics: ['ignored additional manifests: agent-plugins'] })
  })

  it('selects only the newest eligible enabled Claude installation', async () => {
    const project = await temporary('claude-project')
    const home = await temporary('claude-home')
    const dshHome = await temporary('dsh-home')
    const old = join(home, 'cache', 'plugin', '1')
    const latest = join(home, 'cache', 'plugin', '2')
    await mkdir(join(project, '.git'))
    await manifest(old, 'claude', 'old')
    await manifest(latest, 'claude', 'latest')
    await mkdir(join(home, 'plugins'), { recursive: true })
    await writeFile(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
      'frontend-design@official': [
        { scope: 'user', installPath: old, installedAt: '2026-01-01' },
        { scope: 'project', projectPath: project, installPath: latest, installedAt: '2026-02-01' },
      ],
      'disabled@official': [{ scope: 'user', installPath: old, installedAt: '2026-03-01' }],
    } }))
    await writeFile(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: {
      'frontend-design@official': true, 'disabled@official': false,
    } }))

    const discovered = await discoverPlugins({ cwd: project, dshHome, claudeHome: home, discovery: { defaults: ['claude'] } })
    expect(discovered.plugins).toHaveLength(1)
    expect(discovered.plugins[0]).toMatchObject({
      qualifiedId: 'claude:frontend-design@official', root: await realpath(latest), sourceLabel: 'Claude project', format: 'claude',
    })
  })

  it('contains escaping symlinks and malformed siblings without blocking valid plugins', async () => {
    const container = await temporary('container')
    const outside = await temporary('outside')
    const dshHome = await temporary('home')
    await manifest(join(container, 'valid'), 'agent-plugins', 'valid')
    await manifest(outside, 'agent-plugins', 'outside')
    await symlink(outside, join(container, 'escape'))
    await mkdir(join(container, 'missing-manifest'))

    const discovered = await discoverPlugins({
      dshHome, discovery: { defaults: [], sources: [{ id: 'custom', path: container, layout: 'children' }] },
    })
    expect(discovered.plugins.map(plugin => plugin.qualifiedId)).toEqual(['configured:custom:valid'])
    expect(discovered.diagnostics.map(diagnostic => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('resolves outside'), expect.stringContaining('no selected plugin manifest'),
    ]))
  })
})
