# 兼容包

[English](README.md) | 中文

兼容包把外部 agent 格式转换为现有 DSH 服务，而不将这些格式纳入产品 API 主干。

| 包 | 职责 | 运行时贡献 |
|---|---|---|
| [`agent-plugins/`](agent-plugins/README.md) | Agent Plugins 1.0 目录的私有孵化适配器 | `ctx.skills` 提供方与官方 `dsh-mcp-client` 子 fiber |

兼容包保持显式启用。每个包必须在自己的 README 中定义所支持的标准版本、校验与故障隔离规则、信任影响和提取条件。
