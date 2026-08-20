# Agent Note: Agent 与 Claude 插件在创建时按 agent 组装

Status: implemented

[English](2026-08-19-per-agent-agent-claude-plugin-compatibility.md) | 中文

## 问题

插件兼容性取决于 agent（智能体）的工作区和信任选择。进程全局插件根目录无法表示两个并发工作区，而挂载到应用上下文的注册项会在 agent 之间泄漏 skill（技能）、command 和工具。发现还必须区分插件包与任意 skill 目录，并选择一个被索引的 Claude 安装，而不是执行每个 cache 版本。

Agent Plugins 1.0 提供严格且厂商中立的格式，但许多既有包使用 Claude manifest（元数据清单）、旧版 command 与客户端风格 MCP 配置。支持两种格式时，必须保留严格标准 loader，以及 DSH 既有的 skill、command、凭据和 MCP 实现。

## 决策

私有孵化包 `@deepseek-ai/dsh-agent-plugins` 注册一个有序的 `ctx.agents.registerSetup()` 贡献。每个新建或恢复的 agent 会在发布前获得一个不可变 generation。所有已接受组件都挂载到该 agent 的 `agent.ctx`；agent dispose（资源释放）或兼容配置项 dispose 会撤销 generation。配置项加载或重载时不修改既有 agent，文件系统变更需要重建 agent。`ctx.agents.create()` 与 `ctx.agents.resume()` 是受支持的公开创建路径；同步循环构造器被移除，因此 setup 无法被绕过。

一个兼容配置项首先发现已配置来源；其次发现项目 `.dsh/plugins`、`.agents/plugins` 与 `.claude/plugins`；最后发现 `$DSH_HOME/plugins`、`~/.agents/plugins` 及被索引的 Claude 安装。会话 cwd 最近的 Git 上级目录是项目根目录。Claude 已安装索引会为每个插件选择最新且符合条件的用户安装或匹配项目的安装，但不负责 DSH 激活。候选项必须包含 `plugin.json` 或 `.claude-plugin/plugin.json`；两者并存时 Agent Plugins 优先，除非已配置来源强制指定格式。规范根目录会在解析符号链接后执行包含性检查，并按首次发现去重。[工作区插件目录激活](2026-08-20-workspace-plugin-catalog-activation.md)负责发现与激活的分离及持久开关。

Agent Plugins 路径保留内置的 1.0.0 schema、固定的 Agent Skills revision、manifest 例外、`600` rank、严格变量规则、条目隔离及安全的 stdio 和 Streamable HTTP 转换。Claude 适配器支持 manifest 标识、声明或约定位置的 Agent Skills、旧版 command 和 `.mcp.json`。它只识别 agent、hook、LSP 服务器和 output style，以把兼容状态标记为 partial。两种适配器复用标准 skill 解析器，并把官方 MCP 客户端挂载为有作用域的子 fiber。

Claude command 名称保留插件 namespace。调用时会对受支持的参数和路径各展开一次，把动态 shell 与文件注入形式替换为模型可见的省略标记，并通过 `agent.followup()` 以持久 `agent-plugin-command` 来源排队 Markdown。`allowed-tools` 仍是元数据，不授予 DSH 权限。

Claude MCP 凭据引用在 agent setup 时通过 `ctx.credentials` 解析一次。缺失值只会使对应服务器失败。重连沿用该 generation 已解析的启动配置；凭据轮换在新建 agent 上生效。MCP 服务器预留包含 DSH 作用域，而模型可见 namespace 与 agent id 无关。官方客户端的跨 origin 重定向移除规则继续作为 HTTP 认证边界。

`agentPlugin.list(agent)` 为活跃 agent 的工作区公开不含路径和 secret 的目录。条目携带实际 manifest 名称、来源、格式、期望启用状态及活跃 generation 状态。私有浏览器配套包渲染扁平列表，并在不重新扫描的情况下重新获取快照。

## 验证

生命周期测试覆盖 setup 顺序、取消、回滚、配置 agent、恢复 agent、subagent、贡献移除和 teardown。发现与适配器 fixture（测试前置数据）覆盖来源顺序、项目根目录、Claude 版本选择、格式优先级、符号链接包含性、command、凭据、传输和 sibling 隔离。作用域集成会在不同 agent 中运行同一个 MCP namespace，并证明配置项与 agent dispose 会移除各自注册。

无密钥 Loader snapshot（快照）会发现项目 `.agents/plugins` Claude 插件、加载其 skill、调用带 namespace 的 command，并调用确定性的本地 stdio MCP 工具。浏览器覆盖会在两个 agent 清单之间切换，并断言其实际名称。可选 corpus 保留严格 Agent Plugins 示例，并增加 Anthropic 官方仓库中固定版本的 `frontend-design` 与 `commit-commands` 包，且不会执行第三方 command 或联系远程服务。

## 考虑过的替代方案

**全局挂载兼容插件。** 不予采用，因为工作区发现与组件所有权都属于特定 agent；全局注册会在会话间泄漏能力，也无法独立撤销一个 agent。

**发现每种客户端与无 manifest skill bundle。** 不予采用，因为 Codex、OpenCode 和无 manifest marketplace 约定会引入各自的安装与 cache 策略，却不会增强 Agent／Claude 垂直切片。

**MCP 重连时重新解析凭据，或在 HMR（热模块替换）期间附加到活跃 agent。** 不予采用，因为两者都会产生可变 generation。创建事务是唯一快照边界：重建 agent 才能采用变更后的凭据、配置或文件。

**实现另一套 MCP 传输。** 不予采用，因为这会把工具投影、重连、安全加固和 dispose 与官方客户端分裂。

## 后果

两个 agent 可以运行不同的兼容插件并复用稳定 MCP 工具名称，而不会共享注册项。严格 Agent Plugins 行为仍可独立测试，同时 Claude 包获得有用的 skill、command 和 MCP 兼容能力，不受支持的内容则有明确 partial 状态。

该功能仍是可选且位于树内。启用它意味着信任插件指令与 stdio 宿主代码；后者在模型工具沙箱之外以已清理环境执行。Codex 与 OpenCode 支持、无 manifest 包、实时重载、连接健康、安装、独立提取和发布仍是单独决策。
