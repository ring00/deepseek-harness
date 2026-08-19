# @deepseek-ai/dsh-agent-plugins

English | [中文](README.zh.md)

Private incubation adapter for [Agent Plugins 1.0.0](https://agent-plugins.org/specification). One Cordis row loads one local Agent Plugin directory, registers its [Agent Skills](https://agentskills.io/specification), and mounts each supported MCP server through the official `@deepseek-ai/dsh-mcp-client` implementation.

This package is not in the DSH CLI dependency set, a shipped profile, or the plugin installer. It has no `dsh.bundle` manifest and runs only in tests or an explicit development overlay.

## Configuration

```yaml
- id: local-agent-plugin
  name: '@deepseek-ai/dsh-agent-plugins'
  config:
    root: /absolute/path/to/agent-plugin
    # dataDir: /absolute/persistent/path
    # mcp:
    #   toolCallTimeoutMs: 60000
    #   reconnect:
    #     enabled: true
    #     initialDelayMs: 500
    #     maxDelayMs: 30000
    #     maxAttempts: 10
```

| Field | Required | Description |
|---|---|---|
| `root` | yes | Absolute path to one Agent Plugin directory; activation canonicalizes it with `realpath` |
| `dataDir` | no | Absolute persistent writable directory; defaults to `$DSH_HOME/agent-plugins/data/<manifest-name>-<root-hash>` |
| `mcp.toolCallTimeoutMs` | no | Per-tool-call timeout forwarded to every translated MCP client |
| `mcp.reconnect` | no | Reconnect policy forwarded to every translated MCP client |

The instance hash is the first 12 hexadecimal characters of SHA-256 over the canonical root. An explicit `dataDir` keeps state stable when an installation moves. Cordis configuration HMR replaces the complete row; filesystem edits inside the Agent Plugin directory are not watched.

## Validation and discovery

The package vendors the immutable Agent Plugins 1.0.0 JSON schemas and records their SHA-256 hashes plus the Agent Skills source revision in [`schemas/standards-lock.json`](schemas/standards-lock.json). Runtime activation never fetches a standard.

An invalid or unsupported `plugin.json` fails the row. Unknown manifest fields and non-object `extensions` are reported and ignored; recognized extension namespace contents are retained without validation, and no extension namespace is implemented. A missing `skills` directory or `mcp.json` is valid. A fixed component path with the wrong kind or a resolved path outside the canonical root disables that component type. Individual invalid skills and MCP entries are reported and skipped. Every containment check follows symlinks.

Skill discovery reads only immediate `skills/*/SKILL.md` entries. It enforces standard frontmatter fields, lengths, name syntax, and equality between the skill name and directory name. Definitions are parsed once during activation. The provider is named `agent-plugin:<manifest-name>:<instance-hash>`, uses source `agent-plugin` and rank `600`, preserves skill names, and sets `resourceBase` to the skill directory. Optional standard fields are retained below `metadata['agentskills.io']`; `allowed-tools` is metadata only and grants no approval or sandbox exemption.

## MCP translation and trust

`stdio` and `streamable-http` entries are supported; legacy `sse` entries are reported and skipped. Every valid entry owns an independently disposed child Cordis fiber, and a failed sibling neither rejects the row nor removes working siblings.

For stdio, `./` commands resolve inside the canonical plugin root and bare commands resolve against DSH's scrubbed base `PATH` before plugin environment values are applied. Only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand, once, in arguments, environment values, and `cwd`. Reserved variables are injected last with platform-appropriate case semantics. Explicit working directories must resolve below the plugin root or data directory. `PLUGIN_DATA` exists before launch.

For Streamable HTTP, the endpoint must be absolute HTTP(S), contain no credentials or fragment, and use HTTPS except on loopback. Header names must be valid and unique ignoring case. Values remain literal: the adapter performs no placeholder, secret, or OAuth expansion. The official MCP client attaches configured headers only while a request remains on the configured origin; cross-origin redirects receive none of those headers.

Enabling a row is a trust decision. Skills influence model instructions, and stdio servers execute trusted host code with a scrubbed environment outside the model tool sandbox.

## Portable API and evidence

`@deepseek-ai/dsh-agent-plugins/portable` exposes discovery and translation without importing Cordis. The host supplies the default data root, executable-search path, platform semantics, and optional diagnostics or executable resolver. Offline fixtures cover schema selection, validation exceptions, symlink containment, variable expansion, environment and URL rules, isolation, lifecycle, persistence, and namespace derivation. A keyless assembled replay loads a fixture skill and invokes a deterministic Node stdio MCP tool. `DSH_AGENT_PLUGINS_CORPUS=1` enables the lock-file corpus runner, which fetches pinned repositories into a temporary directory and validates discovery without starting external commands or contacting their services.

## Model Experience

### Imported skills

#### What the model sees

The existing skill catalog and loader expose each accepted skill under its unchanged name and description, then return its parsed body and resources when selected. Normal DSH provider precedence applies: lower rank wins, followed by provider registration order.

#### Token effect

Catalog names and descriptions consume request tokens while the skill catalog is present. A selected skill adds its body through the existing skill-loading path; unselected bodies do not enter context.

#### KV Cache effect

Stable while the accepted skill set, descriptions, and selected bodies are unchanged. HMR replacement or a different plugin root can alter the first affected catalog or skill token.

### Imported MCP tools

#### What the model sees

Each connected server contributes the official MCP client's server-qualified tools and results. The adapter changes only the stable server namespace and connection configuration; rendering and session behavior remain owned by `dsh-mcp-client`.

#### Token effect

Every registered tool schema consumes request tokens, and calls retain their arguments and rendered results according to the official MCP client's rules.

#### KV Cache effect

Stable while translated server identities and discovered tool schemas are unchanged. Server discovery changes replace the affected definitions.

## Known Limitations and Deferred Work

- Only Agent Skills, stdio MCP, and Streamable HTTP MCP are implemented. Agent Plugin extension namespaces and legacy HTTP+SSE have no runtime adapter.
- There is no downloader, updater, marketplace, Claude cache discovery, directory watcher, Web UI, or MCP status integration.
- Claude-specific manifests, commands, hooks, and agents are outside this compatibility target.
- The package remains private and in-tree until offline conformance, assembled snapshots, packed-consumer checks, and the pinned real-plugin corpus pass together. Standalone extraction is a separately authorized change and adds the distribution bundle, disabled template row, released-version matrix, and community catalog metadata.
