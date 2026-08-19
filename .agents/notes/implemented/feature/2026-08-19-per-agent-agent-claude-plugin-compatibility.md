# Agent Note: Agent and Claude plugins compose per agent at creation

Status: implemented

English | [中文](2026-08-19-per-agent-agent-claude-plugin-compatibility.zh.md)

## Problem

Plugin compatibility depends on the agent's workspace and trust choices. A process-global plugin root cannot represent two concurrent workspaces, and registrations mounted on the application context leak skills, commands, and tools between agents. Discovery also has to distinguish a package from an arbitrary skill directory and follow Claude's enabled installation state rather than execute every cached version.

Agent Plugins 1.0 provides a strict vendor-neutral format, while many existing packages use Claude's manifest, legacy commands, and client-style MCP configuration. Supporting both formats must retain the strict standard loader and DSH's existing skill, command, credential, and MCP implementations.

## Decision

The private `@deepseek-ai/dsh-agent-plugins` incubation package registers one ordered `ctx.agents.registerSetup()` contribution. Every newly created or resumed agent receives one immutable generation before publication. All accepted components mount on that agent's `agent.ctx`; agent disposal or compatibility-row disposal unwinds the generation. Existing agents are not modified when the row loads or reloads, and filesystem changes require agent recreation. `ctx.agents.create()` and `ctx.agents.resume()` are the supported public creation paths; the synchronous loop constructor is removed so setup cannot be bypassed.

One compatibility row discovers configured sources first, project `.dsh/plugins` and `.claude/plugins` second, and `$DSH_HOME/plugins` plus enabled Claude installations last. The nearest Git ancestor of the session cwd is the project root. Claude selection reads the installed index and effective user, project, and local settings, then chooses the newest eligible enabled installation. Candidates require `plugin.json` or `.claude-plugin/plugin.json`; Agent Plugins wins when both exist unless a configured source forces a format. Canonical roots are contained after symlink resolution and deduplicated by first discovery.

The Agent Plugins path retains the vendored 1.0.0 schemas, pinned Agent Skills revision, manifest exceptions, rank `600`, strict variable rules, entry isolation, and secure stdio and Streamable HTTP translation. The Claude adapter supports manifest identity, declared or conventional Agent Skills, legacy commands, and `.mcp.json`. It recognizes agents, hooks, LSP servers, and output styles only to mark compatibility partial. Both adapters reuse the standard skill parser and mount the official MCP client as scoped child fibers.

Claude command names retain their plugin namespace. Invocation expands the supported arguments and paths once, replaces dynamic shell and file-injection forms with model-visible omission markers, and queues the Markdown through `agent.followup()` under durable `agent-plugin-command` provenance. `allowed-tools` remains metadata and grants no DSH permission.

Claude MCP credential references resolve through `ctx.credentials` once during agent setup. Missing values fail only the affected server. Reconnects keep that generation's resolved launch configuration; credential rotation takes effect on a newly created agent. MCP server reservations include DSH scope while their model-visible namespaces remain independent of agent ids. The official client's cross-origin redirect stripping remains the HTTP authentication boundary.

`agentPlugin.list(agent)` exposes a path-free, secret-free snapshot containing only attempted enabled candidates. Entries carry actual manifest name, source, format, component counts, and `loaded`, `partial`, or `failed` status. The private browser companion renders the flat list and refetches it without rescanning.

## Verification

Lifecycle tests cover setup ordering, cancellation, rollback, configured and resumed agents, subagents, contribution removal, and teardown. Discovery and adapter fixtures cover source order, project roots, Claude enabled-version selection, format precedence, symlink containment, commands, credentials, transports, and sibling isolation. Scoped integration runs the same MCP namespace in separate agents and proves row and agent disposal remove their registrations.

A keyless Loader snapshot discovers a project Claude plugin, loads its skill, invokes its namespaced command, and calls a deterministic local stdio MCP tool. Browser coverage switches between two agent inventories and asserts their actual names. The opt-in corpus retains the strict Agent Plugins examples and adds pinned `frontend-design` and `commit-commands` packages from Anthropic's official repository without executing third-party commands or contacting remote services.

## Alternatives considered

**Mount compatible plugins globally.** Rejected because workspace discovery and component ownership are agent-specific; a global registration leaks capabilities across sessions and cannot unwind one agent independently.

**Discover every client and manifestless skill bundle.** Rejected because Codex, OpenCode, `.agents`, and manifestless marketplace conventions add separate enablement and cache policies without strengthening the Agent/Claude vertical slice.

**Re-resolve credentials on MCP reconnect or attach to live agents during HMR.** Rejected because both create mutable generations. The creation transaction is the one snapshot boundary: recreate the agent to adopt changed credentials, configuration, or files.

**Implement another MCP transport.** Rejected because it would split tool projection, reconnection, security hardening, and disposal from the official client.

## Consequences

Two agents can run different compatible plugins and reuse stable MCP tool names without sharing registrations. Strict Agent Plugins behavior remains independently testable, while Claude packages gain useful skill, command, and MCP compatibility with explicit partial status for unsupported content.

The feature remains opt-in and in-tree. Enabling it trusts plugin instructions and stdio host code, which executes outside the model tool sandbox with a scrubbed environment. Codex and OpenCode support, manifestless packages, live reload, connection health, installation, standalone extraction, and publication remain separate decisions.
