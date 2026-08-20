# Agent Note: Workspace plugin catalogs separate discovery from activation

Status: implemented

English | [中文](2026-08-20-workspace-plugin-catalog-activation.zh.md)

## Problem

The compatibility service originally treated another client's activation metadata as DSH policy and omitted every disabled installation from its inventory. That made the Agent Plugins view incomplete and gave users no DSH-owned way to stop a discovered plugin from contributing model instructions or executing stdio MCP host code. It also made Claude's cache index appear to be the product's plugin directory even though its useful role is selecting one installed version.

Discovery and activation have different lifetimes. Discovery depends on the selected agent's canonical workspace and snapshots filesystem state during agent creation. Activation is a persistent user choice for that workspace. Changing the latter must not mutate the former's already-published skills, commands, and MCP children in place.

## Decision

The built-in catalog includes configured sources; project `.dsh/plugins`, `.agents/plugins`, and `.claude/plugins`; then `$DSH_HOME/plugins`, `~/.agents/plugins`, and Claude's installed index. Every candidate still requires `plugin.json` or `.claude-plugin/plugin.json`. Claude's index contributes at most the newest eligible user or matching project installation for each plugin, regardless of Claude enablement. It is a version selector, never DSH's activation authority, and unindexed cache versions remain invisible.

All discovered plugins default to enabled. The compatibility Cordis plugin registers the required `agent-plugins` settings namespace with `applies: restart`. Its value is a map from workspace key to disabled qualified IDs. A workspace key is the first 12 hexadecimal characters of the SHA-256 digest of the canonical nearest Git root; an agent without a cwd uses the stable `user` bucket. Qualified IDs are already path-free and bind the source identity to the selected plugin.

`agentPlugin.setEnabled(agent, qualifiedId, enabled)` accepts IDs only from that live agent's discovered catalog. Writes are serialized, duplicate IDs are removed, and obsolete IDs remain harmlessly stored until a later write touches their bucket. A read-only settings provider rejects mutation. The method returns a refreshed snapshot whose `enabled` fields show the desired state immediately.

The live generation remains immutable. Disabling a loaded plugin does not dispose its registrations, and enabling a disabled plugin does not parse or mount it. A new or resumed agent reads the latest setting during setup. This makes `enabled` the desired next-generation state and `status` the current generation state; their disagreement is an explicit pending transition.

Disabled candidates receive manifest-only inspection for name, version, and format. Inspection does not create plugin data, parse skills or commands, resolve credentials or executables, or translate MCP. A disabled entry reports `disabled` and omits component counts. Enabled candidates retain `loaded`, `partial`, or `failed` and the existing isolated component behavior.

The browser view lists the complete discovered catalog and renders an accessible switch for each entry. It disables switches while a write is pending or settings are read-only, adopts the snapshot returned by a successful mutation, and preserves the previous snapshot on failure. Refresh only refetches the current generation; it never rescans the filesystem.

## Verification

Discovery fixtures cover project and user `.agents` sources, ordering, home overrides, canonical containment, indexed Claude plugins regardless of Claude enablement, newest-version selection, and unindexed cache exclusion. Adapter coverage proves manifest inspection ignores malformed component files. Settings integration covers default activation, workspace isolation, pending live generations, later-agent adoption, read-only rejection, and disposal. The Loader snapshot discovers the compatible Claude fixture through project `.agents/plugins` and exercises its skill, command, and local stdio MCP server. Browser coverage pins disabled, pending-enable, pending-disable, read-only, saving, successful write, and failed write states.

## Alternatives considered

**Keep Claude activation as the default.** Rejected because DSH would silently change behavior when another client edits its settings, and plugins discovered outside Claude still need one coherent activation model.

**Use one global disabled list.** Rejected because the same qualified source can be trusted in one workspace and rejected in another. The agent's nearest Git root already defines discovery, so its digest defines the matching settings bucket without exposing a path.

**Apply toggles by remounting the live generation.** Rejected because skill, command, and MCP registration would become a partially mutable transaction with reconnect and rollback races. Agent setup is the existing atomic publication point.

**Parse disabled plugins fully for accurate counts.** Rejected because parsing can create data, resolve secrets and executables, and prepare host-code transports. A disabled plugin must stay inert beyond manifest identity.

## Consequences

The Agent Plugins tab now answers both questions separately: what compatible plugins DSH found for this workspace, and which ones should the next agent generation activate. Claude-disabled installations remain visible and default enabled in DSH, so the presence of a supported installation source plus the DSH toggle is the explicit trust model.

The settings document may retain IDs for removed plugins, and a toggle does not change the currently running agent. Both are deliberate: stale IDs have no effect, while immutable generations keep setup, disposal, and model-visible registrations coherent. Global policy, live remounting, filesystem watching, installers, Codex, and OpenCode remain separate decisions.
