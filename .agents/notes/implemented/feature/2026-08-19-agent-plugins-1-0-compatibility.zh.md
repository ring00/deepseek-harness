# Agent Note: Agent Plugins 1.0 兼容性以私有 Cordis 插件孵化

Status: implemented

[English](2026-08-19-agent-plugins-1-0-compatibility.md) | 中文

## 问题

Agent Plugins 为 skill 和 MCP 服务器提供厂商中立的打包格式，而 DSH 运行时组合由 Cordis 插件与现有服务注册表构成。若直接在 CLI 中加载 Agent Plugin 目录，外部文件系统格式会与产品启动耦合，skill 与 MCP 实现会重复，并且在校验、隔离和分发行为获得一致性证据前就引入宿主代码执行。

兼容目标还包含两个不同的生命周期关注点。格式发现与转换可以跨宿主保持可移植，而 DSH 注册与 teardown 必须遵循 Cordis effect 所有权。把这些关注点纠缠在单一适配器中，会导致后续提取为社区可安装插件时必须重新设计。

## 决策

`@deepseek-ai/dsh-agent-plugins` 是 [`packages/compat/agent-plugins`](../../../../packages/compat/agent-plugins/README.md) 下的私有包。每个 Cordis 配置行拥有一个规范 Agent Plugin 根目录、一个内存 skill 提供方，以及每个有效 MCP 服务器对应的一个官方 `dsh-mcp-client` 子 fiber。本包没有 `dsh.bundle` 清单，也不进入 CLI、随附 profile 或插件安装器。它只用于测试和显式开发 overlay。

可移植 loader 持有版本化 schema、manifest 例外、Agent Skills 解析、规范路径、稳定标识、stdio 环境转换、HTTP 策略和条目级诊断。它不导入 Cordis。适配器提供 DSH home 与已清理环境输入，注册已解析 skill 提供方，并将受支持 MCP 记录转换为子 fiber。Cordis dispose 拥有每项注册与每个子 fiber，配置 HMR 会替换整行，而不监视插件目录。

Agent Plugins 1.0.0 schema 随 hash 记录内置，Agent Skills 校验固定到一个源 revision。运行时代码绝不获取标准文件。Manifest 以整体失败，组件位置缺失是有效状态，固定位置类型错误或越界只禁用对应组件，格式错误的 skill 或 MCP 条目各自失败。包含性检查会解析文件系统路径和符号链接。

Skills 保留标准名称，使用提供方 rank `600`，并将可选标准字段保存为带 namespace 的元数据。`allowed-tools` 只传递信息，不授予 DSH 权限。MCP 支持限于 stdio 和 Streamable HTTP。每个服务器获得从插件标识与原始服务器 key 派生的稳定有界 namespace，而工具行为仍由官方 MCP 客户端持有。

Stdio 转换在规范根目录内解析本地命令，依据已清理的基础 `PATH` 解析裸可执行文件，只展开一次两个标准插件变量，按平台大小写语义保护保留环境 key，并把显式工作目录限制在插件根目录或持久数据目录内。Streamable HTTP 只接受安全的绝对 endpoint，其中 HTTP 仅限 loopback，并且不执行 secret 或 placeholder 展开。官方客户端会在重定向离开配置 origin 时移除每个已配置 header。

## 验证

逐文件单元覆盖固定 loader 的 manifest 例外、skill 规则、路径与符号链接情形、placeholder 与环境语义、URL 与 header 规则、namespace 派生和条目隔离。Cordis 集成覆盖提供方优先级、子 fiber 所有权、sibling 存活、重连、持久数据、HMR 替换和完整释放。MCP 客户端回归覆盖区分同 origin 与跨 origin 重定向。

无密钥装配示例通过真实 Loader 进程加载 fixture skill，并调用确定性的跨平台 Node stdio MCP 工具。构建包与 Loader 检查保护导出入口和内置 schema。可选 corpus lock 为有代表性的仅 skill、内含资源、stdio 变量和 Streamable HTTP 插件记录仓库、commit、插件根目录、license 及预期组件；它在不运行第三方命令或联系远程服务的情况下校验发现结果。

## 考虑过的替代方案

**直接把适配器加入 CLI 和基础 profile。** 不予采用，因为安装与发现策略会在一致性与信任行为获得独立分发证据前成为产品约定。

**依赖 `dsh-skillport`。** 不予采用，因为它是有用的实现证据，但接受 DSH 专用扩展，而且不持有严格 Agent Plugins manifest 与 MCP 语义。

**在适配器内实现 MCP 客户端。** 不予采用，因为重复传输会分裂重连、工具投影、安全加固和生命周期行为。子 Cordis fiber 保留唯一官方实现并隔离 sibling 故障。

**实现 Claude Code marketplace 兼容性。** 不予采用，因为 Claude 专用 manifest、command、hook、agent、cache 布局和 marketplace 安装位于 Agent Plugins 1.0 之外，会使目标含糊。

**发布 downloader 或自动插件发现。** 不予采用，因为选择与启用就是信任决策。孵化包接受显式绝对根目录，不会通过隐式发现扩大宿主代码执行授权。

## 后果

DSH 可以校验并运行 Agent Plugins 1.0 目录中的 Agent Skills 和受支持 MCP 部分，而无需采用 Claude 专用行为或第二套 skill／MCP 运行时。无效 sibling 得到隔离，持久状态有明确标识规则，HTTP 认证材料不会通过重定向跨 origin 传播。

本包有意不向普通安装 profile 提供。启用显式开发配置行意味着信任 skill 指令与 stdio 宿主代码；已清理环境不会把该代码放入模型工具沙箱。旧版 SSE、extension namespace、状态 UI、marketplace、下载、更新和目录监视仍然不存在。

可移植 loader 与 Cordis 适配器的组织方式允许后续移动整个子树而不重新设计接口。独立分发仍是另行授权的变更：其仓库持有 registry peer range、构建与打包安装校验、默认禁用的 bundle 模板、支持版本测试、release 产物和社区目录准入。
