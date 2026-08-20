/**
 * Filesystem loader and translator for Agent Plugins 1.0 packages.
 *
 * This module has no Cordis dependency. Hosts supply the persistent-data base,
 * executable-search path, and diagnostic sink, then consume immutable skills
 * and native-neutral MCP connection records.
 *
 * @module @deepseek-ai/dsh-agent-plugins/portable
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv'
import which from 'which'
import { parse as parseYaml } from 'yaml'

/** Canonical Agent Plugins 1.0 manifest schema identifier. */
export const PLUGIN_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
/** Canonical Agent Plugins 1.0 MCP schema identifier. */
export const MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
/** Agent Skills source revision used to implement frontmatter validation. */
export const AGENT_SKILLS_REVISION = '69ef37e9424c0a7ea9dd2293b559e43ec8176379'

const MANIFEST_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions',
])
const SKILL_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PLACEHOLDER = /\$\{PLUGIN_(ROOT|DATA)\}/g
const SCHEMA_ROOT = new URL('../schemas/1.0.0/', import.meta.url)

/** Non-fatal compatibility diagnostic emitted while loading one component. */
export interface AgentPluginDiagnostic {
  /** Component or document that owns the diagnostic. */
  readonly subject: string
  /** Actionable description of the ignored or disabled input. */
  readonly message: string
}

/** Validated Agent Plugins manifest fields. */
export interface AgentPluginManifest {
  readonly $schema: typeof PLUGIN_SCHEMA_ID
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly author?: Readonly<{ name?: string; email?: string; url?: string }>
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** One Agent Skill parsed during plugin activation. */
export interface PortableSkill {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly path: string
  readonly resourceBase: string
  /** Adapter-provided invocation policy; strict Agent Skills use both defaults. */
  readonly invocation?: Readonly<{ modelInvocable: boolean; userInvocable: boolean }>
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Translated stdio MCP server. */
export interface PortableStdioServer {
  readonly transport: 'stdio'
  readonly rawKey: string
  readonly serverName: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

/** Translated Streamable HTTP MCP server. */
export interface PortableHttpServer {
  readonly transport: 'streamable-http'
  readonly rawKey: string
  readonly serverName: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** One supported, validated MCP server entry. */
export type PortableMcpServer = PortableStdioServer | PortableHttpServer

/** Complete portable result for one plugin directory. */
export interface LoadedAgentPlugin {
  readonly root: string
  readonly dataDir: string
  readonly instanceHash: string
  readonly manifest: AgentPluginManifest
  readonly skills: readonly PortableSkill[]
  readonly mcpServers: readonly PortableMcpServer[]
  readonly diagnostics: readonly AgentPluginDiagnostic[]
}

/** Host inputs that keep the portable loader independent of DSH services. */
export interface LoadAgentPluginOptions {
  /** Explicit persistent directory, preserved when an installation moves. */
  readonly dataDir?: string
  /** Parent directory used for the default `<name>-<root-hash>` data directory. */
  readonly defaultDataRoot: string
  /** Stable installation identity used instead of the versioned canonical root. */
  readonly instanceIdentity?: string
  /** Sanitized executable search path used before plugin environment overlays. */
  readonly basePath?: string | undefined
  /** Test/corpus substitution for bare executable resolution; defaults to `which`. */
  readonly resolveExecutable?: (command: string, basePath: string | undefined) => Promise<string>
  /** Platform environment-name semantics; defaults to the current platform. */
  readonly platform?: NodeJS.Platform
  /** Optional sink called once for each non-fatal diagnostic. */
  readonly report?: (diagnostic: AgentPluginDiagnostic) => void
}

interface Validators {
  manifest: ValidateFunction
  mcpTop: ValidateFunction
  mcpServer: ValidateFunction
}

let validatorsPromise: Promise<Validators> | undefined

/** Error whose input invalidates the complete Agent Plugin row. */
export class AgentPluginLoadError extends Error {
  override name = 'AgentPluginLoadError'
}

/**
 * Validate one Agent Plugins manifest without loading components or creating data.
 * @param configuredRoot - absolute plugin directory.
 * @param report - optional non-fatal manifest diagnostic sink.
 * @returns the validated manifest.
 */
export async function loadAgentPluginManifest(
  configuredRoot: string,
  report?: (diagnostic: AgentPluginDiagnostic) => void,
): Promise<AgentPluginManifest> {
  if (!isAbsolute(configuredRoot)) throw new AgentPluginLoadError('agent plugin root must be an absolute path')
  const root = await canonicalDirectory(configuredRoot, 'agent plugin root')
  return loadManifest(root, (await loadValidators()).manifest, (subject, message) => report?.({ subject, message }))
}

/**
 * Load and translate one Agent Plugins 1.0 directory without starting MCP servers.
 * @param configuredRoot - required absolute path to the plugin directory.
 * @param options - host-owned persistence, executable search, and diagnostics.
 * @returns validated manifest plus isolated valid skill and MCP entries.
 */
export async function loadAgentPlugin(
  configuredRoot: string,
  options: LoadAgentPluginOptions,
): Promise<LoadedAgentPlugin> {
  if (!isAbsolute(configuredRoot)) throw new AgentPluginLoadError('agent plugin root must be an absolute path')
  if (!isAbsolute(options.defaultDataRoot)) throw new AgentPluginLoadError('defaultDataRoot must be an absolute path')
  if (options.dataDir !== undefined && !isAbsolute(options.dataDir)) {
    throw new AgentPluginLoadError('agent plugin dataDir must be an absolute path')
  }

  const root = await canonicalDirectory(configuredRoot, 'agent plugin root')
  const diagnostics: AgentPluginDiagnostic[] = []
  const report = (subject: string, message: string): void => {
    const diagnostic = { subject, message }
    diagnostics.push(diagnostic)
    options.report?.(diagnostic)
  }
  const validators = await loadValidators()
  const manifest = await loadManifest(root, validators.manifest, report)
  const instanceHash = digest(options.instanceIdentity ?? root)
  const selectedDataDir = options.dataDir ?? join(options.defaultDataRoot, `${manifest.name}-${instanceHash}`)
  await mkdir(selectedDataDir, { recursive: true })
  const dataDir = await canonicalDirectory(selectedDataDir, 'agent plugin dataDir')
  const skills = await loadSkills(root, report)
  const mcpServers = await loadMcpServers({
    root,
    dataDir,
    instanceHash,
    pluginName: manifest.name,
    basePath: options.basePath,
    resolveExecutable: options.resolveExecutable ?? resolveBareExecutable,
    platform: options.platform ?? process.platform,
    validators,
    report,
  })
  return { root, dataDir, instanceHash, manifest, skills, mcpServers, diagnostics }
}

async function loadValidators(): Promise<Validators> {
  validatorsPromise ??= (async () => {
    const [manifestSchema, mcpSchema] = await Promise.all([
      readJson(new URL('plugin.schema.json', SCHEMA_ROOT)),
      readJson(new URL('mcp.schema.json', SCHEMA_ROOT)),
    ])
    const mcpRecord = requireRecord(mcpSchema, 'vendored MCP schema')
    const topSchema = structuredClone(mcpRecord)
    delete topSchema.$id
    const properties = requireRecord(topSchema.properties, 'vendored MCP schema properties')
    properties.mcpServers = { type: 'object' }
    const serverSchema = {
      $schema: mcpRecord.$schema,
      $defs: mcpRecord.$defs,
      $ref: '#/$defs/server',
    }
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    return {
      manifest: ajv.compile(manifestSchema as AnySchema),
      mcpTop: ajv.compile(topSchema as AnySchema),
      mcpServer: ajv.compile(serverSchema as AnySchema),
    }
  })()
  return validatorsPromise
}

async function loadManifest(
  root: string,
  validate: ValidateFunction,
  report: (subject: string, message: string) => void,
): Promise<AgentPluginManifest> {
  const path = await requiredContainedFile(root, join(root, 'plugin.json'), 'plugin.json')
  const parsed = requireRecord(await readJson(path), 'plugin.json')
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!MANIFEST_FIELDS.has(key)) report('plugin.json', `unknown field ${JSON.stringify(key)} ignored`)
    else sanitized[key] = value
  }
  const extensions = sanitized.extensions
  if (extensions !== undefined) {
    if (!isRecord(extensions)) {
      report('plugin.json', 'non-object extensions field ignored')
      delete sanitized.extensions
    } else {
      sanitized.extensions = {}
    }
  }
  if (!validate(sanitized)) {
    throw new AgentPluginLoadError(`invalid plugin.json: ${formatAjvErrors(validate.errors)}`)
  }
  if (isRecord(extensions)) sanitized.extensions = extensions
  return sanitized as unknown as AgentPluginManifest
}

async function loadSkills(
  root: string,
  report: (subject: string, message: string) => void,
): Promise<PortableSkill[]> {
  return loadAgentSkills(root, [join(root, 'skills')], { report })
}

/**
 * Load Agent Skills from declared roots while retaining strict path containment.
 * @param root - canonical plugin root.
 * @param locations - manifest-declared or conventional component locations.
 * @param options - strict or Claude parsing policy and diagnostic sink.
 * @returns every valid contained Agent Skill entry.
 */
export async function loadAgentSkills(
  root: string,
  locations: readonly string[],
  options: {
    readonly adapter?: 'claude'
    readonly report?: (subject: string, message: string) => void
  } = {},
): Promise<PortableSkill[]> {
  const report = options.report ?? (() => {})
  const directories: string[] = []
  const seen = new Set<string>()
  for (const location of locations) {
    const selected = await optionalContainedComponent(root, resolve(root, location), 'directory', 'skills', report)
    if (selected === undefined) continue
    if (await isRegularFile(join(selected, 'SKILL.md'))) directories.push(selected)
    else {
      const entries = (await readdir(selected, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        try {
          const directory = await realpath(join(selected, entry.name))
          if (isContained(root, directory) && await isRegularFile(join(directory, 'SKILL.md'))) directories.push(directory)
        } catch (error) {
          if (!isMissing(error)) report(`skill:${entry.name}`, errorMessage(error))
        }
      }
    }
  }
  const skills: PortableSkill[] = []
  for (const skillDirectory of directories) {
    if (seen.has(skillDirectory)) continue
    seen.add(skillDirectory)
    const directoryName = basename(skillDirectory)
    try {
      const skillPath = await requiredContainedFile(root, join(skillDirectory, 'SKILL.md'), `skill:${directoryName}`)
      skills.push(parseSkill(directoryName, skillDirectory, skillPath, await readFile(skillPath, 'utf8'), options.adapter))
    } catch (error) {
      report(`skill:${directoryName}`, errorMessage(error))
    }
  }
  return skills
}

/** Parse and validate one Agent Skill from already-read content. */
function parseSkill(directoryName: string, directory: string, path: string, content: string, adapter?: 'claude'): PortableSkill {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  if (match === null) throw new Error('SKILL.md requires closed YAML frontmatter')
  const parsed = requireRecord(parseYaml(match[1] as string), 'SKILL.md frontmatter')
  const extraFields = Object.keys(parsed).filter(key => !SKILL_FIELDS.has(key))
  if (adapter === undefined && extraFields.length > 0) throw new Error(`unexpected frontmatter fields: ${extraFields.sort().join(', ')}`)
  const name = requireString(parsed.name, 'skill name')
  const description = requireString(parsed.description, 'skill description')
  if (!SKILL_NAME.test(name) || name.length > 64) throw new Error(`invalid skill name ${JSON.stringify(name)}`)
  if (name !== directoryName) throw new Error(`skill name ${JSON.stringify(name)} must match directory ${JSON.stringify(directoryName)}`)
  if (description.length > 1024) throw new Error('skill description exceeds 1024 characters')

  const standardMetadata: Record<string, unknown> = {}
  if (parsed.license !== undefined) standardMetadata.license = requireString(parsed.license, 'skill license', true)
  if (parsed.compatibility !== undefined) {
    const compatibility = requireString(parsed.compatibility, 'skill compatibility')
    if (compatibility.length > 500) throw new Error('skill compatibility exceeds 500 characters')
    standardMetadata.compatibility = compatibility
  }
  if (parsed['allowed-tools'] !== undefined) {
    standardMetadata['allowed-tools'] = requireString(parsed['allowed-tools'], 'skill allowed-tools', true)
  }
  if (parsed.metadata !== undefined) {
    const metadata = requireRecord(parsed.metadata, 'skill metadata')
    for (const [key, value] of Object.entries(metadata)) requireString(value, `skill metadata.${key}`, true)
    standardMetadata.metadata = metadata
  }
  const adapterMetadata = adapter === undefined ? undefined : Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !SKILL_FIELDS.has(key)),
  )
  return {
    name,
    description,
    content: content.slice(match[0].length),
    path,
    resourceBase: directory,
    ...adapter === undefined ? {} : {
      invocation: {
        modelInvocable: parsed['disable-model-invocation'] !== true,
        userInvocable: parsed['user-invocable'] !== false,
      },
    },
    ...Object.keys(standardMetadata).length === 0 && Object.keys(adapterMetadata ?? {}).length === 0 ? {} : {
      metadata: {
        ...Object.keys(standardMetadata).length === 0 ? {} : { 'agentskills.io': standardMetadata },
        ...Object.keys(adapterMetadata ?? {}).length === 0 ? {} : { 'claude-code': adapterMetadata },
      },
    },
  }
}

interface McpLoadContext {
  root: string
  dataDir: string
  instanceHash: string
  pluginName: string
  basePath: string | undefined
  resolveExecutable: (command: string, basePath: string | undefined) => Promise<string>
  platform: NodeJS.Platform
  validators: Validators
  report: (subject: string, message: string) => void
}

async function loadMcpServers(context: McpLoadContext): Promise<PortableMcpServer[]> {
  const path = await optionalContainedComponent(context.root, join(context.root, 'mcp.json'), 'file', 'mcp.json', context.report)
  if (path === undefined) return []
  let parsed: Record<string, unknown>
  try {
    parsed = requireRecord(await readJson(path), 'mcp.json')
  } catch (error) {
    context.report('mcp.json', errorMessage(error))
    return []
  }
  if (!context.validators.mcpTop(parsed)) {
    context.report('mcp.json', `invalid top-level fields: ${formatAjvErrors(context.validators.mcpTop.errors)}`)
    return []
  }
  const rawServers = requireRecord(parsed.mcpServers, 'mcp.json mcpServers')
  const servers: PortableMcpServer[] = []
  for (const [rawKey, rawServer] of Object.entries(rawServers)) {
    if (!context.validators.mcpServer(rawServer)) {
      context.report(`mcp:${rawKey}`, `invalid server entry: ${formatAjvErrors(context.validators.mcpServer.errors)}`)
      continue
    }
    const server = rawServer as Record<string, unknown>
    if (server.type === 'sse') {
      context.report(`mcp:${rawKey}`, 'legacy sse transport is unsupported and was skipped')
      continue
    }
    try {
      servers.push(server.type === 'stdio'
        ? await translateStdio(rawKey, server, context)
        : translateHttp(rawKey, server, context))
    } catch (error) {
      context.report(`mcp:${rawKey}`, errorMessage(error))
    }
  }
  return servers
}

async function translateStdio(
  rawKey: string,
  server: Record<string, unknown>,
  context: McpLoadContext,
): Promise<PortableStdioServer> {
  const rawCommand = requireString(server.command, 'stdio command')
  let command: string
  if (rawCommand.startsWith('./')) {
    command = await requiredContainedFile(context.root, resolve(context.root, rawCommand.slice(2)), `mcp:${rawKey} command`)
  } else {
    if (rawCommand.includes('/') || rawCommand.includes('\\')) throw new Error('stdio command must be bare or begin with ./')
    command = await context.resolveExecutable(rawCommand, context.basePath)
  }
  const rawEnv = server.env === undefined ? {} : requireRecord(server.env, 'stdio env')
  const reserved = context.platform === 'win32'
    ? (key: string): boolean => key.toUpperCase() === 'PLUGIN_ROOT' || key.toUpperCase() === 'PLUGIN_DATA'
    : (key: string): boolean => key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA'
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawEnv)) {
    if (reserved(key)) throw new Error(`stdio env key ${JSON.stringify(key)} is reserved`)
    env[key] = expandPluginVariables(requireString(value, `stdio env.${key}`, true), context.root, context.dataDir)
  }
  env.PLUGIN_ROOT = context.root
  env.PLUGIN_DATA = context.dataDir
  const rawArgs = server.args === undefined ? [] : server.args as unknown[]
  const args = rawArgs.map((value, index) => expandPluginVariables(requireString(value, `stdio args[${index}]`, true), context.root, context.dataDir))
  const cwd = server.cwd === undefined
    ? context.root
    : await resolveCwd(requireString(server.cwd, 'stdio cwd'), context.root, context.dataDir)
  return {
    transport: 'stdio',
    rawKey,
    serverName: serverNamespace(context.pluginName, rawKey, context.instanceHash),
    command,
    args,
    env,
    cwd,
  }
}

function translateHttp(
  rawKey: string,
  server: Record<string, unknown>,
  context: McpLoadContext,
): PortableHttpServer {
  const rawUrl = requireString(server.url, 'Streamable HTTP url')
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch (error) {
    throw new Error(`invalid Streamable HTTP URL: ${errorMessage(error)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Streamable HTTP URL must use HTTP or HTTPS')
  if (url.username !== '' || url.password !== '') throw new Error('Streamable HTTP URL must not contain credentials')
  if (url.hash !== '') throw new Error('Streamable HTTP URL must not contain a fragment')
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new Error('Streamable HTTP URL must use HTTPS outside loopback')
  }
  const rawHeaders = server.headers === undefined ? {} : requireRecord(server.headers, 'Streamable HTTP headers')
  const headers: Record<string, string> = {}
  const names = new Set<string>()
  for (const [key, value] of Object.entries(rawHeaders)) {
    const folded = key.toLowerCase()
    if (names.has(folded)) throw new Error(`duplicate HTTP header name ${JSON.stringify(key)}`)
    names.add(folded)
    const text = requireString(value, `HTTP header ${key}`, true)
    new Headers([[key, text]])
    headers[key] = text
  }
  return {
    transport: 'streamable-http',
    rawKey,
    serverName: serverNamespace(context.pluginName, rawKey, context.instanceHash),
    url: url.href,
    headers,
  }
}

/**
 * Derive a stable official MCP-client namespace within its 32-character limit.
 * @param pluginName - validated manifest name.
 * @param rawServerKey - exact mcpServers member name.
 * @param instanceIdentity - 12-character hash of the canonical plugin root.
 * @returns normalized prefix plus a 12-character identity/key digest.
 */
export function serverNamespace(pluginName: string, rawServerKey: string, instanceIdentity: string): string {
  const normalized = `${pluginName}__${rawServerKey}`
    .replaceAll(/[^A-Za-z0-9_-]+/g, '_')
    .replaceAll(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'server'
  return `${normalized.slice(0, 19)}_${digest(`${instanceIdentity}\0${rawServerKey}`)}`
}

/**
 * Expand the two Agent Plugins variables once without rescanning replacements.
 * @param value - literal argument, environment value, or working-directory field.
 * @param root - canonical Agent Plugin root used for `PLUGIN_ROOT`.
 * @param dataDir - canonical persistent directory used for `PLUGIN_DATA`.
 * @returns value with supported placeholders replaced once.
 */
export function expandPluginVariables(value: string, root: string, dataDir: string): string {
  return value.replace(PLACEHOLDER, (_match, variable: 'ROOT' | 'DATA') => variable === 'ROOT' ? root : dataDir)
}

async function resolveCwd(raw: string, root: string, dataDir: string): Promise<string> {
  let base: string
  let suffix: string
  if (raw.startsWith('./')) {
    base = root
    suffix = raw.slice(2)
  } else if (raw === '${PLUGIN_ROOT}' || raw.startsWith('${PLUGIN_ROOT}/')) {
    base = root
    suffix = raw.slice('${PLUGIN_ROOT}'.length).replace(/^\//, '')
  } else if (raw === '${PLUGIN_DATA}' || raw.startsWith('${PLUGIN_DATA}/')) {
    base = dataDir
    suffix = raw.slice('${PLUGIN_DATA}'.length).replace(/^\//, '')
  /* v8 ignore start -- the vendored MCP schema rejects every other cwd prefix before translation. */
  } else {
    throw new Error('stdio cwd must begin with ./, ${PLUGIN_ROOT}, or ${PLUGIN_DATA}')
  }
  /* v8 ignore stop */
  const target = await canonicalizePotential(resolve(base, suffix))
  if (!isContained(base, target)) throw new Error('stdio cwd resolves outside its declared root')
  return target
}

async function canonicalizePotential(path: string): Promise<string> {
  let current = path
  const suffix: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      /* v8 ignore next -- Windows alone reports a missing child below a regular-file ancestor as ENOENT; POSIX reports ENOTDIR. */
      if (suffix.length > 0 && !(await stat(canonical)).isDirectory()) throw new Error(`path ancestor is not a directory: ${canonical}`)
      return resolve(canonical, ...suffix.reverse())
    } catch (error) {
      if (!isMissing(error)) throw error
      const parent = resolve(current, '..')
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard. */
      if (parent === current) throw error
      suffix.push(basename(current))
      current = parent
    }
  }
}

async function optionalContainedComponent(
  root: string,
  path: string,
  kind: 'directory' | 'file',
  subject: string,
  report: (subject: string, message: string) => void,
): Promise<string | undefined> {
  try {
    const canonical = await realpath(path)
    if (!isContained(root, canonical)) throw new Error(`${subject} resolves outside the plugin root`)
    const info = await stat(canonical)
    if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error(`${subject} is not a ${kind}`)
    return canonical
  } catch (error) {
    if (!isMissing(error)) report(subject, errorMessage(error))
    return undefined
  }
}

async function requiredContainedFile(root: string, path: string, subject: string): Promise<string> {
  const canonical = await realpath(path)
  if (!isContained(root, canonical)) throw new Error(`${subject} resolves outside the plugin root`)
  if (!(await stat(canonical)).isFile()) throw new Error(`${subject} is not a regular file`)
  return canonical
}

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function canonicalDirectory(path: string, subject: string): Promise<string> {
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) throw new AgentPluginLoadError(`${subject} is not a directory`)
  return canonical
}

function isContained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function isLoopback(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (host.toLowerCase() === 'localhost') return true
  const family = isIP(host)
  return family === 4 ? host.startsWith('127.') : family === 6 && host === '::1'
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

async function readJson(path: string | URL): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${subject} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, subject: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.length === 0)) throw new Error(`${subject} must be ${empty ? 'a string' : 'a non-empty string'}`)
  return value
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  /* v8 ignore next -- Ajv populates errors whenever its validator returns false. */
  if (errors === null || errors === undefined) return 'schema validation failed'
  return errors.map(error => `${error.instancePath || '/'} ${String(error.message)}`).join('; ')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveBareExecutable(command: string, basePath: string | undefined): Promise<string> {
  return which(command, { path: basePath })
}
