/** Per-workspace discovery for Agent Plugins and enabled Claude installations. */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Built-in installation families understood by the MVP. */
export type BuiltinSource = 'dsh' | 'claude'
/** Manifest dialect selected for one plugin root. */
export type PluginFormat = 'auto' | 'agent-plugins' | 'claude'

/** One configured plugin root or immediate-child container. */
export interface DiscoverySource {
  /** Stable source identifier used in diagnostics and persistent data identity. */
  readonly id: string
  /** Absolute path or path relative to the agent project root. */
  readonly path: string
  /** Path anchor; defaults to absolute. */
  readonly base?: 'absolute' | 'project'
  /** Whether the path is one plugin or contains immediate plugin children. */
  readonly layout?: 'plugin' | 'children'
  /** Manifest dialect to select; auto prefers Agent Plugins over Claude. */
  readonly format?: PluginFormat
}

/** Plugin discovery policy. */
export interface DiscoveryConfig {
  readonly defaults?: readonly BuiltinSource[]
  readonly homes?: Partial<Readonly<Record<BuiltinSource, string>>>
  readonly sources?: readonly DiscoverySource[]
}

/** One selected enabled installation before component parsing. */
export interface DiscoveredPlugin {
  readonly qualifiedId: string
  readonly dataIdentity: string
  readonly sourceId: string
  readonly sourceLabel: string
  readonly format: Exclude<PluginFormat, 'auto'>
  readonly root: string
  readonly diagnostics: readonly string[]
}

/** Immutable result of one agent discovery snapshot. */
export interface PluginDiscovery {
  readonly projectRoot?: string
  readonly plugins: readonly DiscoveredPlugin[]
  readonly diagnostics: readonly Readonly<{ source: string; message: string }>[]
}

/** Inputs that make filesystem discovery deterministic in tests. */
export interface DiscoverPluginsOptions {
  readonly cwd?: string
  readonly discovery?: DiscoveryConfig
  readonly dshHome: string
  readonly userHome?: string
  readonly claudeHome?: string
}

interface Candidate {
  readonly root: string
  readonly sourceId: string
  readonly sourceLabel: string
  readonly identity: string
  readonly format: PluginFormat
}

const DEFAULTS: readonly BuiltinSource[] = ['dsh', 'claude']
const MANIFESTS = {
  'agent-plugins': 'plugin.json',
  claude: join('.claude-plugin', 'plugin.json'),
} as const

/**
 * Find the nearest Git ancestor, falling back to the canonical cwd.
 * @param cwd - agent session working directory.
 * @returns the canonical project root.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  const canonical = await realpath(cwd)
  let cursor = canonical
  while (true) {
    if (await exists(join(cursor, '.git'))) return cursor
    const parent = dirname(cursor)
    if (parent === cursor) return canonical
    cursor = parent
  }
}

/**
 * Snapshot configured, project, and user plugin installations for one agent.
 * @param options - workspace and discovery configuration.
 * @returns ordered, canonicalized plugin candidates and contained diagnostics.
 */
export async function discoverPlugins(options: DiscoverPluginsOptions): Promise<PluginDiscovery> {
  if (!isAbsolute(options.dshHome)) throw new TypeError('dshHome must be absolute')
  const projectRoot = options.cwd === undefined ? undefined : await findProjectRoot(options.cwd)
  const config = options.discovery ?? {}
  validateConfig(config, projectRoot)
  const diagnostics: Array<{ source: string; message: string }> = []
  const candidates: Candidate[] = []
  const report = (source: string, message: string): void => { diagnostics.push({ source, message }) }

  for (const source of config.sources ?? []) {
    const base = source.base ?? (isAbsolute(source.path) ? 'absolute' : 'project')
    if (base === 'project' && projectRoot === undefined) continue
    const path = base === 'absolute' ? source.path : resolve(projectRoot as string, source.path)
    await collectDirectory(candidates, path, source.layout ?? 'children', {
      id: `configured:${source.id}`, label: source.id, format: source.format ?? 'auto', report,
    })
  }

  const defaults = config.defaults ?? DEFAULTS
  if (projectRoot !== undefined) {
    if (defaults.includes('dsh')) await collectDirectory(candidates, join(projectRoot, '.dsh', 'plugins'), 'children', {
      id: 'project:dsh', label: 'Project DSH', format: 'auto', report,
    })
    if (defaults.includes('claude')) await collectDirectory(candidates, join(projectRoot, '.claude', 'plugins'), 'children', {
      id: 'project:claude', label: 'Project Claude', format: 'auto', report,
    })
  }
  if (defaults.includes('dsh')) await collectDirectory(candidates, join(config.homes?.dsh ?? options.dshHome, 'plugins'), 'children', {
    id: 'user:dsh', label: 'User DSH', format: 'auto', report,
  })
  if (defaults.includes('claude')) {
    const claudeHome = config.homes?.claude ?? options.claudeHome ?? join(options.userHome ?? homedir(), '.claude')
    await collectClaude(candidates, claudeHome, projectRoot, report)
  }

  const roots = new Set<string>()
  const plugins: DiscoveredPlugin[] = []
  for (const candidate of candidates) {
    const selected = await select(candidate, report)
    if (selected === undefined || roots.has(selected.root)) continue
    roots.add(selected.root)
    plugins.push(Object.freeze(selected))
  }
  return Object.freeze({
    ...projectRoot === undefined ? {} : { projectRoot },
    plugins: Object.freeze(plugins),
    diagnostics: Object.freeze(diagnostics),
  })
}

function validateConfig(config: DiscoveryConfig, projectRoot: string | undefined): void {
  const ids = new Set<string>()
  for (const [name, path] of Object.entries(config.homes ?? {})) {
    if (!isAbsolute(path)) throw new TypeError(`discovery home for ${JSON.stringify(name)} must be absolute`)
  }
  for (const source of config.sources ?? []) {
    if (source.id.length === 0 || ids.has(source.id)) throw new TypeError(`invalid or duplicate discovery source id ${JSON.stringify(source.id)}`)
    ids.add(source.id)
    const base = source.base ?? (isAbsolute(source.path) ? 'absolute' : 'project')
    if (base === 'absolute' && !isAbsolute(source.path)) throw new TypeError(`absolute discovery source ${JSON.stringify(source.id)} requires an absolute path`)
    if (base === 'project' && isAbsolute(source.path)) throw new TypeError(`project discovery source ${JSON.stringify(source.id)} requires a relative path`)
    if (base === 'project' && projectRoot !== undefined && !contained(projectRoot, resolve(projectRoot, source.path))) {
      throw new TypeError(`project discovery source ${JSON.stringify(source.id)} escapes the project root`)
    }
  }
}

async function collectDirectory(
  output: Candidate[],
  path: string,
  layout: 'plugin' | 'children',
  source: { id: string; label: string; format: PluginFormat; report: (source: string, message: string) => void },
): Promise<void> {
  const root = await optionalDirectory(path, source.id, source.report)
  if (root === undefined) return
  if (layout === 'plugin') {
    output.push({ root, sourceId: source.id, sourceLabel: source.label, identity: `${source.id}:${basename(root)}`, format: source.format })
    return
  }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    source.report(source.id, 'plugin container could not be read')
    return
  }
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    try {
      const child = await realpath(join(root, entry.name))
      if (!contained(root, child) || !(await stat(child)).isDirectory()) {
        source.report(source.id, `candidate ${JSON.stringify(entry.name)} resolves outside its source`)
        continue
      }
      output.push({ root: child, sourceId: source.id, sourceLabel: source.label, identity: `${source.id}:${entry.name}`, format: source.format })
    } catch {
      source.report(source.id, `candidate ${JSON.stringify(entry.name)} could not be read`)
    }
  }
}

async function collectClaude(
  output: Candidate[],
  claudeHome: string,
  projectRoot: string | undefined,
  report: (source: string, message: string) => void,
): Promise<void> {
  const source = 'user:claude'
  const installed = await optionalJson(join(claudeHome, 'plugins', 'installed_plugins.json'), source, report)
  if (installed === undefined) return
  if (!record(installed) || !record(installed.plugins)) {
    report(source, 'installed plugin index is malformed')
    return
  }
  const enabled = await claudeEnabled(claudeHome, projectRoot, report)
  for (const [id, rawRecords] of Object.entries(installed.plugins)) {
    if (!enabled.get(id) || !Array.isArray(rawRecords)) continue
    const eligible: Record<string, unknown>[] = []
    for (const value of rawRecords) {
      if (!record(value)) continue
      if (value.scope === 'user') { eligible.push(value); continue }
      if (projectRoot === undefined || (value.scope !== 'project' && value.scope !== 'local')) continue
      if (typeof value.projectPath === 'string') {
        try { if (await realpath(value.projectPath) !== projectRoot) continue } catch { continue }
      }
      eligible.push(value)
    }
    const selected = eligible.toSorted((left, right) => timestamp(left).localeCompare(timestamp(right))).at(-1)
    if (selected === undefined || typeof selected.installPath !== 'string') {
      report(source, `enabled installation ${JSON.stringify(id)} has no eligible path`)
      continue
    }
    output.push({
      root: selected.installPath,
      sourceId: source,
      sourceLabel: selected.scope === 'user' ? 'Claude user' : 'Claude project',
      identity: `claude:${id}`,
      format: 'claude',
    })
  }
}

async function claudeEnabled(
  home: string,
  projectRoot: string | undefined,
  report: (source: string, message: string) => void,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()
  const paths = [join(home, 'settings.json')]
  if (projectRoot !== undefined) paths.push(join(projectRoot, '.claude', 'settings.json'), join(projectRoot, '.claude', 'settings.local.json'))
  for (const path of paths) {
    const parsed = await optionalJson(path, 'user:claude', report)
    if (!record(parsed) || !record(parsed.enabledPlugins)) continue
    for (const [id, value] of Object.entries(parsed.enabledPlugins)) if (typeof value === 'boolean') result.set(id, value)
  }
  return result
}

async function select(candidate: Candidate, report: (source: string, message: string) => void): Promise<DiscoveredPlugin | undefined> {
  let root: string
  try {
    root = await realpath(candidate.root)
    if (!(await stat(root)).isDirectory()) throw new Error()
  } catch {
    report(candidate.sourceId, 'plugin installation could not be read')
    return undefined
  }
  const available = await Promise.all((Object.keys(MANIFESTS) as Array<keyof typeof MANIFESTS>).map(async format => ({
    format,
    present: await containedFile(root, join(root, MANIFESTS[format])),
  })))
  const forced = candidate.format === 'auto' ? undefined : candidate.format
  const selected = forced === undefined
    ? available.find(value => value.present)?.format
    : available.find(value => value.format === forced && value.present)?.format
  if (selected === undefined) {
    report(candidate.sourceId, `candidate ${JSON.stringify(candidate.identity)} has no selected plugin manifest`)
    return undefined
  }
  const ignored = available.filter(value => value.present && value.format !== selected).map(value => value.format)
  return {
    qualifiedId: candidate.identity,
    dataIdentity: candidate.identity,
    sourceId: candidate.sourceId,
    sourceLabel: candidate.sourceLabel,
    format: selected,
    root,
    diagnostics: ignored.length === 0 ? [] : [`ignored additional manifests: ${ignored.join(', ')}`],
  }
}

async function optionalDirectory(
  path: string,
  source: string,
  report: (source: string, message: string) => void,
): Promise<string | undefined> {
  try {
    const canonical = await realpath(path)
    if (!(await stat(canonical)).isDirectory()) {
      report(source, 'configured plugin source is not a directory')
      return undefined
    }
    return canonical
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(source, 'configured plugin source could not be read')
    return undefined
  }
}

async function optionalJson(path: string, source: string, report: (source: string, message: string) => void): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(source, 'configuration JSON could not be read')
    return undefined
  }
}

async function containedFile(root: string, path: string): Promise<boolean> {
  try {
    const canonical = await realpath(path)
    return contained(root, canonical) && (await stat(canonical)).isFile()
  } catch {
    return false
  }
}

function timestamp(value: Record<string, unknown>): string {
  return typeof value.lastUpdated === 'string' ? value.lastUpdated : typeof value.installedAt === 'string' ? value.installedAt : ''
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
