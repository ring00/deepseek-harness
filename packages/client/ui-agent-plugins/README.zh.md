# @deepseek-ai/dsh-client-ui-agent-plugins

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-agent-plugins`](../../compat/agent-plugins/README.md) 的私有 Web 配套包。它为所选活跃 agent（智能体）贡献 **Agent 插件**会话视图。

该视图调用 `agentPlugin.list` 并渲染扁平清单：实际 manifest（元数据清单）名称、来源、所选格式、加载状态、版本、组件计数，以及一条可选的已净化错误。它覆盖加载中、非活跃会话、空清单和传输错误状态。刷新会重新获取不可变 agent generation 快照，不会重新扫描插件目录。

本包使用独立浏览器入口，因为宿主与浏览器分别编译。孵化期间，两个入口都只通过显式开发 overlay 加载；随附 Web profile 不包含它们。

## 模型体验

无，因为该视图读取宿主清单，不贡献模型可见内容。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 不呈现 MCP 连接健康状态、disabled 或 stale 安装，也不提供可展开诊断。
- 凭据、配置或目录编辑后，既有 agent 的视图不会改变；需要重建 agent 才能获得新 generation。
