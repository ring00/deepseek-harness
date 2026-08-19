# @deepseek-ai/dsh-agent-plugins

English | [中文](README.zh.md)

Private incubation adapter for [Agent Plugins 1.0.0](https://agent-plugins.org/specification) and a bounded subset of Claude Code plugins. One Cordis row discovers compatible plugins for every newly created or resumed DSH agent, mounts accepted skills, commands, and MCP servers on that agent's `agent.ctx`, and publishes a path-free inventory for the optional Web companion.

The package is absent from the DSH CLI dependency set, shipped profiles, and plugin installer. It has no `dsh.bundle` manifest and runs only through tests or an explicit development overlay.

## Configuration

```yaml
- id: agent-plugins
  name: '@deepseek-ai/dsh-agent-plugins'
  config:
    discovery:
      defaults: [dsh, claude]
      # homes:
      #   dsh: /absolute/dsh-home
      #   claude: /absolute/claude-home
      # sources:
      #   - id: team-plugins
      #     path: .team/plugins
      #     base: project
      #     layout: children
      #     format: auto
    # dataRoot: /absolute/persistent/data
    # mcp:
    #   toolCallTimeoutMs: 60000
    #   reconnect:
    #     enabled: true
```

One compatibility row may be active. `discovery.defaults: []` disables built-in locations; configured sources still run first in declaration order. A source path is absolute or relative to the agent's project root and describes either one plugin (`layout: plugin`) or immediate plugin children (`layout: children`). `format` may force `agent-plugins` or `claude`; `auto` prefers Agent Plugins when both manifests exist.

The default order is configured sources, project `.dsh/plugins` and `.claude/plugins`, then `$DSH_HOME/plugins` and enabled installations from Claude's installed index and effective user/project settings. The nearest Git ancestor of `session.header.cwd` is the project root; an agent without a cwd receives user sources only. Discovery requires `plugin.json` or `.claude-plugin/plugin.json`, resolves symlinks before containment and deduplication, and never treats an arbitrary `skills/` directory as a plugin.

Discovery is an immutable agent-generation snapshot. Agent creation and resume await it through `ctx.agents.registerSetup()` before publication. Existing agents do not gain plugins when the row loads or reloads, and plugin files are not watched; recreate the agent to rescan. Disposing the row stops future setup and removes every generation it owns.

## Supported components

| Format | Skills | Commands | MCP | Recognized only |
|---|---|---|---|---|
| Agent Plugins 1.0 | strict Agent Skills | — | stdio, Streamable HTTP | extension namespaces |
| Claude Code | declared or conventional Agent Skills | declared or conventional legacy commands | `.mcp.json` stdio, Streamable HTTP | agents, hooks, LSP servers, output styles |

The strict loader vendors immutable Agent Plugins schemas and records their hashes plus the pinned Agent Skills revision in [`schemas/standards-lock.json`](schemas/standards-lock.json). Claude adaptation reuses the same Agent Skill parser and containment helpers where the formats overlap. Invalid component entries are diagnosed and skipped without removing valid siblings; a plugin with skipped or recognized-only content is `partial`.

Skills retain their names and use provider `agent-plugin:<manifest-name>:<instance-hash>`, source `agent-plugin`, rank `600`, and their skill directory as `resourceBase`. Optional standard fields remain namespaced metadata. `allowed-tools` never grants DSH approval or sandbox exemptions.

Legacy Claude commands are registered on the agent-scoped `ctx.commands` registry with names such as `/commit-commands:commit`. Invocation expands arguments and the supported session/project/plugin/data/command paths once, then queues the Markdown through `agent.followup()` with durable source `agent-plugin-command`. Dynamic shell and file-injection constructs are replaced by model-visible omission markers; they are never executed by the command handler.

## MCP and trust

Every accepted server mounts the official `@deepseek-ai/dsh-mcp-client` as an independently disposed child fiber. Stable namespaces do not contain agent ids, while MCP reservations include the DSH scope so the same namespace may exist in different agents. Legacy SSE is recognized and skipped.

Agent Plugins use the strict `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` rules. Claude MCP values additionally resolve `${NAME}`, `${NAME:-default}`, and `env_vars` through `ctx.credentials` once during agent setup. An existing agent retains those values after credential rotation; a newly created agent resolves the new values. Missing credentials fail only their MCP entry.

Stdio commands use a scrubbed parent environment, resolve bare executables before plugin environment overrides, inject reserved variables last, and restrict explicit working directories to the plugin root or data directory. Streamable HTTP requires an absolute HTTP(S) URL, HTTPS outside loopback, no URL credentials or fragment, and valid case-insensitively unique headers. The official client strips configured headers on cross-origin redirects.

Enabling the row is the trust decision. Skills and commands influence model instructions, and stdio MCP servers execute trusted host code outside the model tool sandbox.

## Inventory and evidence

`agentPlugin.list(agent)` returns only mounted or attempted enabled candidates with actual manifest name, version, source, selected format, `loaded`/`partial`/`failed` status, component counts, and at most one sanitized error summary. It does not report MCP connection health. The private [`@deepseek-ai/dsh-client-ui-agent-plugins`](../../client/ui-agent-plugins/README.md) companion renders this snapshot as a flat conversation view; Refresh refetches the snapshot and never rescans disk.

The dependency-light exports `./portable`, `./discovery`, and `./adapters` support conformance tests without mounting Cordis. Offline fixtures cover validation, source order, Claude enabled-version selection, path containment, commands, credentials, transports, isolation, and teardown. The assembled keyless snapshot discovers a project Claude plugin and exercises one skill, command, and deterministic local stdio MCP tool. `DSH_AGENT_PLUGINS_CORPUS=1` fetches pinned Agent Plugins examples plus Anthropic's `frontend-design` and `commit-commands` into temporary directories and validates translation without executing their commands or contacting remote services.

## Model Experience

### Imported skills and tools

#### What the model sees

Accepted skills enter the existing `skill` catalog under unchanged names. Connected MCP servers contribute the official client's server-qualified tool schemas and results. A legacy command adds its expanded Markdown as an ordinary durable follow-up.

#### Token effect

Skill catalog entries and MCP tool schemas consume request tokens. Selected skill bodies, command prompts, and MCP results enter history through their existing DSH paths.

#### KV Cache effect

Stable for the lifetime of one agent generation while its accepted skill set, command output, and MCP schemas are unchanged. Recreating the agent may discover a different installation or resolve different credentials.

## Known Limitations and Deferred Work

- Codex, OpenCode, `.agents`, manifestless marketplace bundles, disabled/stale inventory, and Claude marketplace installation are not supported.
- Claude agents, hooks, LSP servers, output styles, dynamic command execution, file injection, and legacy SSE are not executed.
- Credential changes, configuration reloads, and plugin-directory edits do not alter an existing agent.
- There is no downloader, updater, filesystem watcher, MCP health UI, live-agent HMR attachment, or standalone distribution. Extraction and publication require a separate authorized change.
