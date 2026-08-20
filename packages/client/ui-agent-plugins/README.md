# @deepseek-ai/dsh-client-ui-agent-plugins

English | [中文](README.zh.md)

Private Web companion for [`@deepseek-ai/dsh-agent-plugins`](../../compat/agent-plugins/README.md). It contributes an **Agent Plugins** conversation view for the selected live agent.

The view calls `agentPlugin.list` and renders the selected workspace's complete discovered catalog: actual manifest name, source, selected format, desired enablement, live-generation status, version, optional component counts, and one optional sanitized error. Each entry has an accessible switch backed by `agentPlugin.setEnabled`; read-only settings disable the controls, and a failed write preserves the previous state. A pending label identifies choices that take effect only after agent recreation. It covers loading, inactive-session, empty, and transport-error states. Refresh refetches the immutable agent-generation snapshot; it does not rescan plugin directories.

This package has a separate browser entry because host and browser compilation are separate. During incubation both entries load only through the explicit development overlay; no shipped Web profile includes them.

## Model Experience

None, as the view reads host inventory and contributes no model-visible content.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- MCP connection health, stale Claude installation records, and expandable diagnostics are not represented.
- Toggle, credential, configuration, or directory changes do not alter the existing generation; recreate the agent to apply them.
