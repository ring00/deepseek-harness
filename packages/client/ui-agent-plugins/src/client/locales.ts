/** Translation keys owned by the Agent Plugins view. */
export type AgentPluginsLocaleKey = keyof typeof en
/** English copy for the Agent Plugins view. */
export const en = {
  tab: 'Agent Plugins', loading: 'Loading agent plugins…', error: 'Agent plugin status is unavailable.',
  refresh: 'Refresh', empty: 'No compatible plugins were discovered for this workspace.',
  inactive: 'Select an active conversation to inspect its plugins.', loaded: 'Loaded', partial: 'Partial', failed: 'Failed',
  disabled: 'Disabled', enabled: 'Enabled', enabledNext: 'Enabled next session', disabledNext: 'Disabled next session',
  notice: 'Discovered plugins are enabled by default. Skills affect model instructions, stdio MCP runs host code, and changes apply to new sessions.',
  toggleError: 'The plugin setting could not be saved.', skills: 'skills', commands: 'commands', mcpServers: 'MCP servers',
} as const
/** Chinese copy for the Agent Plugins view. */
export const zh: Record<AgentPluginsLocaleKey, string> = {
  tab: 'Agent 插件', loading: '正在加载 Agent 插件…', error: '无法获取 Agent 插件状态。', refresh: '刷新',
  empty: '没有为此工作区发现兼容插件。', inactive: '请选择一个活跃会话以检查其插件。',
  loaded: '已加载', partial: '部分兼容', failed: '失败', disabled: '已禁用', enabled: '启用',
  enabledNext: '将在下个会话启用', disabledNext: '将在下个会话禁用',
  notice: '发现的插件默认启用。技能会影响模型指令，stdio MCP 会运行主机代码，更改将在新会话中生效。',
  toggleError: '无法保存插件设置。', skills: '技能', commands: '命令', mcpServers: 'MCP 服务器',
}
