# @deepseek-ai/dsh-client-ui-agent-plugins

English | [中文](README.zh.md)

Private Web companion for [`@deepseek-ai/dsh-agent-plugins`](../../compat/agent-plugins/README.md). It contributes an **Agent Plugins** conversation view for the selected live agent.

The view calls `agentPlugin.list` and renders a flat inventory: actual manifest name, source, selected format, load status, version, component counts, and one optional sanitized error. It covers loading, inactive-session, empty, and transport-error states. Refresh refetches the immutable agent-generation snapshot; it does not rescan plugin directories.

This package has a separate browser entry because host and browser compilation are separate. During incubation both entries load only through the explicit development overlay; no shipped Web profile includes them.

## Model Experience

None, as the view reads host inventory and contributes no model-visible content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- MCP connection health, disabled or stale installations, and expandable diagnostics are not represented.
- An existing agent's view does not change after credential, configuration, or directory edits; recreate the agent to obtain a new generation.
