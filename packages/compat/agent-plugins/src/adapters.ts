/** Best-effort Claude Code adaptation beside the strict Agent Plugins loader. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import which from 'which'
import { parse as parseYaml } from 'yaml'
import type { DiscoveredPlugin } from './discovery.ts'
import {
  loadAgentPlugin,
  loadAgentSkills,
  serverNamespace,
  type AgentPluginDiagnostic,
  type PortableMcpServer,
  type PortableSkill,
} from './portable.ts'

const PLUGIN_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u
const COMMAND_SEGMENT = /^[a-z][a-z0-9_-]*$/u
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu
const DYNAMIC_COMMAND = /!`[^`]*(?:`|$)/gu
const FILE_INJECTION = /(^|\s)@(?:(?:\.\/|\/)[^\s`]+|[A-Za-z0-9_.-]+\/[^\s`]+)/gu

/** Manifest identity shared by strict and Claude plugins. */
export interface CompatiblePluginManifest {
  readonly name: string
  readonly version?: string
}

/** One parsed legacy Claude command. */
export interface PortableCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly template: string
  readonly directory: string
  readonly partial: boolean
}

/** Complete neutral plugin result consumed by an agent generation. */
export interface LoadedCompatiblePlugin {
  readonly qualifiedId: string
  readonly root: string
  readonly dataDir: string
  readonly instanceHash: string
  readonly format: 'agent-plugins' | 'claude'
  readonly manifest: CompatiblePluginManifest
  readonly skills: readonly PortableSkill[]
  readonly commands: readonly PortableCommand[]
  readonly mcpServers: readonly PortableMcpServer[]
  readonly unsupportedComponents: readonly string[]
  readonly diagnostics: readonly AgentPluginDiagnostic[]
}

/** Host inputs for portable loading and setup-time credential resolution. */
export interface LoadCompatiblePluginOptions {
  readonly dataRoot: string
  readonly basePath?: string
  readonly resolveExecutable?: (command: string, basePath: string | undefined) => Promise<string>
  readonly resolveCredential?: (name: string) => Promise<string | undefined>
  readonly report?: (diagnostic: AgentPluginDiagnostic) => void
}

/** Inputs available to one Claude command invocation. */
export interface ClaudeCommandExpansionContext {
  readonly rawInput: string
  readonly sessionId: string
  readonly projectRoot?: string
  readonly pluginRoot: string
  readonly pluginData: string
  readonly commandDirectory: string
}

/**
 * Load one enabled discovered plugin through its selected adapter.
 * @param candidate - discovered root and selected manifest format.
 * @param options - persistent data, executable, credential, and diagnostic services.
 * @returns the parsed portable components for one agent generation.
 */
export async function loadCompatiblePlugin(
  candidate: DiscoveredPlugin,
  options: LoadCompatiblePluginOptions,
): Promise<LoadedCompatiblePlugin> {
  if (!isAbsolute(options.dataRoot)) throw new TypeError('dataRoot must be absolute')
  const instanceHash = digest(candidate.dataIdentity)
  const dataDir = await stableDataDir(options.dataRoot, candidate.qualifiedId, instanceHash)
  if (candidate.format === 'agent-plugins') {
    const loaded = await loadAgentPlugin(candidate.root, {
      dataDir,
      defaultDataRoot: options.dataRoot,
      instanceIdentity: candidate.dataIdentity,
      ...options.basePath === undefined ? {} : { basePath: options.basePath },
      ...options.resolveExecutable === undefined ? {} : { resolveExecutable: options.resolveExecutable },
      ...options.report === undefined ? {} : { report: options.report },
    })
    return {
      qualifiedId: candidate.qualifiedId,
      root: loaded.root,
      dataDir: loaded.dataDir,
      instanceHash: loaded.instanceHash,
      format: 'agent-plugins',
      manifest: { name: loaded.manifest.name, ...loaded.manifest.version === undefined ? {} : { version: loaded.manifest.version } },
      skills: loaded.skills,
      commands: [],
      mcpServers: loaded.mcpServers,
      unsupportedComponents: Object.keys(loaded.manifest.extensions ?? {}),
      diagnostics: loaded.diagnostics,
    }
  }

  const diagnostics: AgentPluginDiagnostic[] = []
  const report = (subject: string, message: string): void => {
    const diagnostic = Object.freeze({ subject, message })
    diagnostics.push(diagnostic)
    options.report?.(diagnostic)
  }
  for (const message of candidate.diagnostics) report('discovery', message)
  const root = await canonicalDirectory(candidate.root)
  const raw = record(JSON.parse(await readFile(await containedFile(root, join(root, '.claude-plugin', 'plugin.json')), 'utf8')))
  const name = string(raw.name, 'plugin name')
  if (!PLUGIN_NAME.test(name)) throw new Error(`invalid Claude plugin name ${JSON.stringify(name)}`)
  const skills = await loadAgentSkills(root, locations(raw.skills) ?? ['./skills'], { adapter: 'claude', report })
  const commands = await loadCommands(root, name, locations(raw.commands) ?? ['./commands'], report)
  const mcpServers = await loadMcp(root, dataDir, name, instanceHash, locations(raw.mcp ?? raw.mcpServers)?.[0] ?? './.mcp.json', {
    basePath: options.basePath,
    resolveExecutable: options.resolveExecutable ?? ((command, path) => which(command, { path })),
    resolveCredential: options.resolveCredential ?? (() => Promise.resolve(undefined)),
    report,
  })
  const unsupportedComponents = await unsupported(root, raw)
  for (const component of unsupportedComponents) report(`component:${component}`, `${component} is recognized but unsupported`)
  return {
    qualifiedId: candidate.qualifiedId,
    root,
    dataDir,
    instanceHash,
    format: 'claude',
    manifest: { name, ...typeof raw.version === 'string' ? { version: raw.version } : {} },
    skills,
    commands,
    mcpServers,
    unsupportedComponents,
    diagnostics,
  }
}

async function loadCommands(
  root: string,
  pluginName: string,
  declared: readonly string[],
  report: (subject: string, message: string) => void,
): Promise<PortableCommand[]> {
  const files: Array<{ path: string; base: string }> = []
  for (const location of declared) {
    const selected = await optionalContained(root, location, 'commands', report)
    if (selected === undefined) continue
    if ((await stat(selected)).isFile()) {
      if (extname(selected) === '.md') files.push({ path: selected, base: dirname(selected) })
    } else await collectCommandFiles(root, selected, selected, files, report)
  }
  const commands: PortableCommand[] = []
  for (const { path, base } of files.toSorted((left, right) => left.path.localeCompare(right.path))) {
    try {
      const parsed = frontmatter(await readFile(path, 'utf8'), false)
      const stem = relative(base, path).slice(0, -extname(path).length)
      const segments = stem.split(sep).map(segment => segment.toLowerCase())
      if (segments.length === 0 || segments.some(segment => !COMMAND_SEGMENT.test(segment))) throw new Error(`invalid command path ${JSON.stringify(stem)}`)
      const name = `${pluginName}:${segments.join(':')}`
      commands.push({
        name,
        description: typeof parsed.attributes.description === 'string' && parsed.attributes.description.trim() !== ''
          ? parsed.attributes.description : `Claude command ${name}`,
        ...typeof parsed.attributes['argument-hint'] === 'string' ? { argumentHint: parsed.attributes['argument-hint'] } : {},
        template: parsed.body,
        directory: dirname(path),
        partial: dynamic(parsed.body),
      })
    } catch (error) {
      report(`command:${relative(root, path)}`, message(error))
    }
  }
  return commands
}

async function collectCommandFiles(
  root: string,
  base: string,
  directory: string,
  files: Array<{ path: string; base: string }>,
  report: (subject: string, message: string) => void,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    try {
      const child = await realpath(join(directory, entry.name))
      if (!contained(root, child)) throw new Error('command path resolves outside the plugin root')
      if ((await stat(child)).isDirectory()) await collectCommandFiles(root, base, child, files, report)
      else if (extname(child) === '.md') files.push({ path: child, base })
    } catch (error) {
      report(`command:${entry.name}`, message(error))
    }
  }
}

async function loadMcp(
  root: string,
  dataDir: string,
  pluginName: string,
  instanceHash: string,
  location: string,
  options: {
    basePath: string | undefined
    resolveExecutable: (command: string, basePath: string | undefined) => Promise<string>
    resolveCredential: (name: string) => Promise<string | undefined>
    report: (subject: string, message: string) => void
  },
): Promise<PortableMcpServer[]> {
  const path = await optionalContained(root, location, 'MCP configuration', options.report)
  if (path === undefined || !(await stat(path)).isFile()) return []
  let parsed: Record<string, unknown>
  try { parsed = record(JSON.parse(await readFile(path, 'utf8'))) } catch (error) { options.report('mcp', message(error)); return [] }
  const rawServers = record(parsed.mcpServers ?? parsed)
  const result: PortableMcpServer[] = []
  for (const [rawKey, rawValue] of Object.entries(rawServers)) {
    try {
      const value = record(rawValue)
      const type = typeof value.type === 'string' ? value.type : undefined
      if (type === 'sse') { options.report(`mcp:${rawKey}`, 'legacy sse transport is unsupported and was skipped'); continue }
      const serverName = serverNamespace(pluginName, rawKey, instanceHash)
      if (typeof value.command === 'string' || type === 'stdio') {
        const rawCommand = string(value.command, 'stdio command')
        const command = rawCommand.startsWith('./')
          ? await containedFile(root, resolve(root, rawCommand.slice(2)))
          : rawCommand.includes('/') || rawCommand.includes('\\')
            ? (() => { throw new Error('stdio command must be bare or begin with ./') })()
            : await options.resolveExecutable(rawCommand, options.basePath)
        const args = await Promise.all(strings(value.args, 'stdio args').map(value => expand(value, root, dataDir, options.resolveCredential)))
        const rawEnv = value.env === undefined ? {} : record(value.env)
        const env: Record<string, string> = {}
        const reserved = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'])
        for (const [key, raw] of Object.entries(rawEnv)) {
          if ([...reserved].some(name => process.platform === 'win32' ? name === key.toUpperCase() : name === key)) throw new Error(`stdio env key ${JSON.stringify(key)} is reserved`)
          env[key] = await expand(string(raw, `stdio env.${key}`, true), root, dataDir, options.resolveCredential)
        }
        for (const key of strings(value.env_vars, 'stdio env_vars')) {
          env[key] = await requiredCredential(key, options.resolveCredential)
        }
        env.PLUGIN_ROOT = root
        env.PLUGIN_DATA = dataDir
        env.CLAUDE_PLUGIN_ROOT = root
        const rawCwd = value.cwd === undefined ? root : await expand(string(value.cwd, 'stdio cwd'), root, dataDir, options.resolveCredential)
        const cwd = await canonicalDirectory(isAbsolute(rawCwd) ? rawCwd : resolve(root, rawCwd))
        if (!contained(root, cwd) && !contained(dataDir, cwd)) throw new Error('stdio cwd resolves outside the plugin root and data directory')
        result.push({ transport: 'stdio', rawKey, serverName, command, args, env, cwd })
      } else if (typeof value.url === 'string' || type === 'http' || type === 'streamable-http') {
        const url = await expand(string(value.url, 'Streamable HTTP url'), root, dataDir, options.resolveCredential)
        const rawHeaders = value.headers === undefined ? {} : record(value.headers)
        const headers: Record<string, string> = {}
        for (const [key, raw] of Object.entries(rawHeaders)) headers[key] = await expand(string(raw, `HTTP header ${key}`, true), root, dataDir, options.resolveCredential)
        validateHttp(url, headers)
        result.push({ transport: 'streamable-http', rawKey, serverName, url, headers })
      } else throw new Error('MCP server must declare stdio command or Streamable HTTP url')
    } catch (error) {
      options.report(`mcp:${rawKey}`, message(error))
    }
  }
  return result
}

/**
 * Expand a Claude command template without executing Claude dynamic context.
 * @param command - parsed legacy command template.
 * @param context - invocation arguments and stable runtime paths.
 * @returns model-visible Markdown and whether compatibility is partial.
 */
export function expandClaudeCommand(command: PortableCommand, context: ClaudeCommandExpansionContext): { text: string; partial: boolean } {
  const args = parseArguments(context.rawInput)
  const values: Record<string, string | undefined> = {
    ARGUMENTS: args.raw, SESSION_ID: context.sessionId, CLAUDE_SESSION_ID: context.sessionId,
    PROJECT_ROOT: context.projectRoot, CLAUDE_PROJECT_DIR: context.projectRoot,
    PLUGIN_ROOT: context.pluginRoot, CLAUDE_PLUGIN_ROOT: context.pluginRoot,
    PLUGIN_DATA: context.pluginData, COMMAND_DIR: context.commandDirectory, ...args.named,
  }
  const mentionsArguments = /\$(?:\{ARGUMENTS\}|ARGUMENTS)\b/u.test(command.template)
  let text = command.template.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|([0-9]+))/gu,
    (match, braced: string | undefined, plain: string | undefined, index: string | undefined) => {
      if (index !== undefined) return args.positional[Number(index) - 1] ?? ''
      const key = braced ?? plain
      return key === undefined ? match : values[key] ?? match
    })
  if (!mentionsArguments && args.raw !== '') text = `${text.trimEnd()}\n\n${args.raw}\n`
  const partial = command.partial || dynamic(text)
  text = text.replace(DYNAMIC_COMMAND, '[Claude dynamic command omitted; use ordinary DSH tools and approvals if needed.]')
    .replace(FILE_INJECTION, '$1[Claude file injection omitted; use ordinary DSH file tools if needed.]')
  return Object.freeze({ text, partial })
}

function parseArguments(rawInput: string): { raw: string; positional: string[]; named: Record<string, string> } {
  const raw = rawInput.trim()
  const positional: string[] = []
  let token = '', quote: "'" | '"' | undefined, escaped = false, started = false
  const push = (): void => { if (started) positional.push(token); token = ''; started = false }
  for (const character of raw) {
    if (escaped) { token += character; escaped = false; started = true; continue }
    if (character === '\\' && quote !== "'") { escaped = true; started = true; continue }
    if ((character === "'" || character === '"') && (quote === undefined || quote === character)) { quote = quote === character ? undefined : character; started = true; continue }
    if (/\s/u.test(character) && quote === undefined) { push(); continue }
    token += character; started = true
  }
  if (quote !== undefined) throw new Error('Claude command arguments contain an unclosed quote')
  if (escaped) token += '\\'
  push()
  const named: Record<string, string> = {}
  for (const value of positional) {
    const match = /^(?:--)?([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/u.exec(value)
    if (match !== null) named[match[1] as string] = match[2] as string
  }
  return { raw, positional, named }
}

async function expand(
  value: string,
  root: string,
  dataDir: string,
  resolver: (name: string) => Promise<string | undefined>,
): Promise<string> {
  let cursor = 0, output = ''
  for (const match of value.matchAll(VARIABLE)) {
    output += value.slice(cursor, match.index)
    const name = match[1] as string
    output += name === 'PLUGIN_ROOT' || name === 'CLAUDE_PLUGIN_ROOT' ? root
      : name === 'PLUGIN_DATA' ? dataDir
        : await requiredCredential(name, resolver, match[2])
    cursor = match.index + match[0].length
  }
  return output + value.slice(cursor)
}

async function requiredCredential(
  name: string,
  resolver: (name: string) => Promise<string | undefined>,
  fallback?: string,
): Promise<string> {
  const value = await resolver(name)
  if (value === undefined && fallback === undefined) {
    throw new Error(`required credential reference ${JSON.stringify(name)} is not configured`)
  }
  return value ?? fallback as string
}

function validateHttp(raw: string, headers: Readonly<Record<string, string>>): void {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('invalid Streamable HTTP URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Streamable HTTP URL must use HTTP or HTTPS')
  if (url.username !== '' || url.password !== '' || url.hash !== '') throw new Error('Streamable HTTP URL must not contain credentials or a fragment')
  if (url.protocol !== 'https:' && !loopback(url.hostname)) throw new Error('Streamable HTTP URL must use HTTPS outside loopback')
  const names = new Set<string>()
  for (const [key, value] of Object.entries(headers)) {
    const folded = key.toLowerCase()
    if (names.has(folded)) throw new Error(`duplicate HTTP header name ${JSON.stringify(key)}`)
    names.add(folded); new Headers([[key, value]])
  }
}

async function unsupported(root: string, manifest: Record<string, unknown>): Promise<string[]> {
  const result = new Set<string>()
  for (const key of ['agents', 'hooks', 'lspServers', 'outputStyles']) if (manifest[key] !== undefined) result.add(key)
  for (const key of ['agents', 'hooks']) if (await exists(join(root, key))) result.add(key)
  return [...result].sort()
}

function frontmatter(
  content: string,
  required: boolean,
): { attributes: Record<string, unknown>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content)
  if (match === null) { if (required) throw new Error('frontmatter is required'); return { attributes: {}, body: content } }
  return { attributes: record(parseYaml(match[1] as string)), body: content.slice(match[0].length) }
}

async function optionalContained(
  root: string,
  location: string,
  subject: string,
  report: (subject: string, message: string) => void,
): Promise<string | undefined> {
  if (isAbsolute(location)) { report(subject, 'absolute component locations are unsupported'); return undefined }
  try {
    return await containedPath(root, resolve(root, location))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(subject, message(error))
    return undefined
  }
}

async function containedFile(root: string, path: string): Promise<string> {
  const canonical = await containedPath(root, path)
  if (!(await stat(canonical)).isFile()) throw new Error('component path is not a regular file')
  return canonical
}

async function containedPath(root: string, path: string): Promise<string> {
  const canonical = await realpath(path)
  if (!contained(root, canonical)) throw new Error('component path resolves outside the plugin root')
  return canonical
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) throw new Error('path is not a directory')
  return canonical
}

async function stableDataDir(dataRoot: string, id: string, hash: string): Promise<string> {
  await mkdir(dataRoot, { recursive: true })
  const root = await canonicalDirectory(dataRoot)
  const prefix = id.replaceAll(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'plugin'
  const path = join(root, `${prefix}-${hash}`)
  await mkdir(path, { recursive: true })
  const canonical = await canonicalDirectory(path)
  if (!contained(root, canonical)) throw new Error('plugin data directory resolves outside dataRoot')
  return canonical
}

function locations(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}

function strings(value: unknown, subject: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error(`${subject} must be an array of strings`)
  return value
}

function string(value: unknown, subject: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && value === '')) throw new Error(`${subject} must be a ${empty ? '' : 'non-empty '}string`)
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function loopback(hostname: string): boolean {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  return host.toLowerCase() === 'localhost' || (isIP(host) === 4 ? host.startsWith('127.') : isIP(host) === 6 && host === '::1')
}

function dynamic(value: string): boolean {
  DYNAMIC_COMMAND.lastIndex = 0
  FILE_INJECTION.lastIndex = 0
  return DYNAMIC_COMMAND.test(value) || FILE_INJECTION.test(value)
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 12) }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true } catch { return false } }
