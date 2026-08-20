# @deepseek-ai/dsh-agent-plugins

[English](README.md) | 中文

这是 [Agent Plugins 1.0.0](https://agent-plugins.org/specification) 与 Claude Code 插件有限子集的私有孵化适配器。一个 Cordis 配置项会为每个新建或恢复的 DSH agent（智能体）发现兼容插件，把已接受的 skill（技能）、command 与 MCP 服务器挂载到该 agent 的 `agent.ctx`，并为可选 Web 配套包发布不含路径的清单。

本包不属于 DSH CLI（命令行界面）依赖集、随附 profile 或插件安装器。它没有 `dsh.bundle` manifest（元数据清单），只通过测试或显式开发 overlay 运行。

## 配置

```yaml
- id: agent-plugins
  name: '@deepseek-ai/dsh-agent-plugins'
  config:
    discovery:
      defaults: [dsh, agents, claude]
      # homes:
      #   dsh: /absolute/dsh-home
      #   agents: /absolute/agents-home
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

只能有一个活跃兼容配置项。`discovery.defaults: []` 会禁用内置位置；已配置来源仍最先按声明顺序运行。来源路径可以是绝对路径，也可以相对于 agent 项目根目录，并描述单个插件（`layout: plugin`）或直接子插件（`layout: children`）。`format` 可强制选择 `agent-plugins` 或 `claude`；`auto` 在两种 manifest 都存在时优先选择 Agent Plugins。

默认顺序是已配置来源；项目 `.dsh/plugins`、`.agents/plugins` 与 `.claude/plugins`；然后是 `$DSH_HOME/plugins`、`~/.agents/plugins` 及 Claude 已安装索引中选出的安装。Claude 索引会为每个插件选择最新且符合条件的用户安装或匹配项目的安装，包括在 Claude 中被禁用的插件；它不负责 DSH 激活状态，也不会扫描未被索引引用的 cache 版本。`session.header.cwd` 最近的 Git 上级目录是项目根目录；没有 cwd 的 agent 只接收用户来源。发现要求存在 `plugin.json` 或 `.claude-plugin/plugin.json`，在包含性与去重前解析符号链接，并且绝不把任意 `skills/` 目录视为插件。

发现结果是不可变的 agent generation 快照。Agent 创建与恢复会在发布前通过 `ctx.agents.registerSetup()` 等待它。配置项加载或重载时，既有 agent 不会获得插件，也不会监视插件文件；需要重建 agent 才会重新扫描。dispose（资源释放）配置项会停止后续 setup，并移除它拥有的全部 generation。

每个发现的插件在 DSH 中默认启用。必需的 `agent-plugins` settings（设置）section 会把不含路径的禁用 ID 列表存储在规范项目根目录摘要之下；没有 cwd 的 agent 共用稳定的 `user` bucket。`agentPlugin.setEnabled(agent, id, enabled)` 只更改未来 generation 的期望状态，不会修改 Claude 设置或活跃 agent。禁用插件只进行 manifest 标识检查：在后续 agent generation 启用前，DSH 不会创建其数据目录、解析组件、解析凭据或可执行文件，也不会转换 MCP。

## 支持的组件

| 格式 | Skills | Commands | MCP | 仅识别 |
|---|---|---|---|---|
| Agent Plugins 1.0 | 严格 Agent Skills | — | stdio、Streamable HTTP | extension namespace |
| Claude Code | 声明或约定位置的 Agent Skills | 声明或约定位置的旧版 command | `.mcp.json` stdio、Streamable HTTP | agent、hook、LSP 服务器、output style |

严格 loader 内置不可变 Agent Plugins schema，并在 [`schemas/standards-lock.json`](schemas/standards-lock.json) 中记录其 hash 及固定 Agent Skills revision。格式重叠处，Claude 适配会复用同一个 Agent Skill 解析器与包含性辅助函数。无效组件条目会被诊断并跳过，不会移除有效 sibling；含有已跳过或仅识别内容的插件状态为 `partial`。

Skills 保留原名称，使用 `agent-plugin:<manifest-name>:<instance-hash>` 提供方、`agent-plugin` source、`600` rank，并以其 skill 目录作为 `resourceBase`。可选标准字段保留为命名空间元数据。`allowed-tools` 绝不授予 DSH 批准或沙箱豁免。

旧版 Claude command 以 `/commit-commands:commit` 等名称注册到 agent 作用域的 `ctx.commands` 注册表。调用时会对参数及受支持的会话／项目／插件／数据／command 路径各展开一次，然后通过 `agent.followup()` 以持久来源 `agent-plugin-command` 排队 Markdown。动态 shell 与文件注入结构会替换为模型可见的省略标记；command handler 绝不会执行它们。

## MCP 与信任

每个已接受服务器都把官方 `@deepseek-ai/dsh-mcp-client` 挂载为独立释放的子 fiber。稳定 namespace 不包含 agent id，而 MCP 预留会包含 DSH 作用域，因此不同 agent 可以使用同一个 namespace。旧版 SSE 会被识别并跳过。

Agent Plugins 使用严格的 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}` 规则。Claude MCP 值还会在 agent setup 时通过 `ctx.credentials` 解析一次 `${NAME}`、`${NAME:-default}` 与 `env_vars`。凭据轮换后，既有 agent 保留原值；新建 agent 解析新值。缺失凭据只会使对应 MCP 条目失败。

Stdio command 使用已清理的父环境，在插件环境覆盖前解析裸可执行文件，最后注入保留变量，并把显式工作目录限制在插件根目录或数据目录之下。Streamable HTTP 要求绝对 HTTP(S) URL、loopback 外使用 HTTPS、不含 URL 凭据或 fragment，且 header 有效并在忽略大小写后唯一。官方客户端会在跨 origin 重定向时移除已配置 header。

让已发现插件保持启用就是信任决策。Skills 与 commands 会影响模型指令；stdio MCP 服务器会在模型工具沙箱之外执行受信任的宿主代码。

## 清单与证据

`agentPlugin.list(agent)` 返回所选工作区中完整的已发现目录，包含实际 manifest 名称、版本、来源、所选格式、期望 `enabled` 状态，以及活跃 generation 的 `loaded`／`partial`／`failed`／`disabled` 状态。已加载条目包含组件计数与最多一条已净化错误摘要；禁用条目省略计数。快照会说明 settings 提供方是否可写，但不报告 MCP 连接健康状态。`agentPlugin.setEnabled(agent, id, enabled)` 会验证目录成员身份、串行写入 settings 并返回更新后的快照。期望状态与活跃状态不一致时，选择会等待 agent 重建后生效。私有 [`@deepseek-ai/dsh-client-ui-agent-plugins`](../../client/ui-agent-plugins/README.md) 配套包把该快照渲染为扁平会话视图；刷新只重新获取快照，绝不重新扫描磁盘。

依赖较轻的 `./portable`、`./discovery` 与 `./adapters` 导出可在不挂载 Cordis 的情况下执行一致性测试。离线 fixture（测试前置数据）覆盖校验、来源顺序、Claude 版本选择、`.agents` 发现、路径包含性、settings 隔离、command、凭据、传输、组件隔离及 teardown。装配后的无密钥 snapshot（快照）会发现项目 `.agents/plugins` Claude 插件，并执行一个 skill、command 与确定性的本地 stdio MCP 工具。设置 `DSH_AGENT_PLUGINS_CORPUS=1` 会把固定的 Agent Plugins 示例以及 Anthropic `frontend-design` 和 `commit-commands` 获取到临时目录，并在不执行其 command 或联系远程服务的情况下校验转换。

## 模型体验

### 导入的 skills 与工具

#### 模型看到的内容

已接受 skill 以未修改的名称进入现有 `skill` 目录。已连接 MCP 服务器贡献官方客户端的服务器限定工具 schema 与结果。旧版 command 会把展开后的 Markdown 作为普通持久 follow-up 添加。

#### Token 影响

Skill 目录条目与 MCP 工具 schema 会消耗请求 token。已选择 skill 正文、command 提示词与 MCP 结果通过各自现有 DSH 路径进入历史。

#### KV Cache 影响

只要已接受 skill 集、command 输出与 MCP schema 不变，就会在一个 agent generation 生命周期内保持稳定。重建 agent 可能发现不同安装或解析出不同凭据。

## 已知限制与暂缓事项

- 不支持 Codex、OpenCode、无 manifest marketplace bundle、陈旧 Claude 安装记录或 Claude marketplace 安装。
- 不执行 Claude agent、hook、LSP 服务器、output style、动态 command、文件注入或旧版 SSE。
- 开关、凭据、配置和插件目录变更不会改变既有 agent。
- 没有 downloader、updater、文件系统 watcher、MCP 健康 UI、实时 agent HMR 附加或独立分发。提取与发布需要另行授权。
