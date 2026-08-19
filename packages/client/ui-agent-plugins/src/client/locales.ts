/** Translation keys owned by the Agent Plugins view. */
export type AgentPluginsLocaleKey = keyof typeof en
/** English copy for the Agent Plugins view. */
export const en = {
  tab: 'Agent Plugins', loading: 'Loading agent plugins…', error: 'Agent plugin status is unavailable.',
  refresh: 'Refresh', empty: 'No compatible plugins were discovered for this workspace.',
  inactive: 'Select an active conversation to inspect its plugins.', loaded: 'Loaded', partial: 'Partial', failed: 'Failed',
  skills: 'skills', commands: 'commands', mcpServers: 'MCP servers',
} as const
/** Chinese copy for the Agent Plugins view. */
export const zh: Record<AgentPluginsLocaleKey, string> = {
  tab: 'Agent 插件', loading: '正在加载 Agent 插件…', error: '无法获取 Agent 插件状态。', refresh: '刷新',
  empty: '没有为此工作区发现兼容插件。', inactive: '请选择一个活跃会话以检查其插件。',
  loaded: '已加载', partial: '部分兼容', failed: '失败', skills: '技能', commands: '命令', mcpServers: 'MCP 服务器',
}
