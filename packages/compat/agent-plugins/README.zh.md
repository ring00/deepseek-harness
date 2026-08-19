# @deepseek-ai/dsh-agent-plugins

[English](README.md) | 中文

这是 [Agent Plugins 1.0.0](https://agent-plugins.org/specification) 的私有孵化适配器。每个 Cordis 配置行加载一个本地 Agent Plugin 目录，注册其 [Agent Skills](https://agentskills.io/specification)，并通过官方 `@deepseek-ai/dsh-mcp-client` 实现挂载每个受支持的 MCP 服务器。

本包不属于 DSH CLI 依赖集、随附 profile 或插件安装器。它没有 `dsh.bundle` 清单，只在测试或显式开发 overlay 中运行。

## 配置

```yaml
- id: local-agent-plugin
  name: '@deepseek-ai/dsh-agent-plugins'
  config:
    root: /absolute/path/to/agent-plugin
    # dataDir: /absolute/persistent/path
    # mcp:
    #   toolCallTimeoutMs: 60000
    #   reconnect:
    #     enabled: true
    #     initialDelayMs: 500
    #     maxDelayMs: 30000
    #     maxAttempts: 10
```

| 字段 | 必填 | 描述 |
|---|---|---|
| `root` | 是 | 一个 Agent Plugin 目录的绝对路径；激活时通过 `realpath` 规范化 |
| `dataDir` | 否 | 绝对的持久可写目录；默认为 `$DSH_HOME/agent-plugins/data/<manifest-name>-<root-hash>` |
| `mcp.toolCallTimeoutMs` | 否 | 转发到每个已转换 MCP 客户端的单次工具调用超时 |
| `mcp.reconnect` | 否 | 转发到每个已转换 MCP 客户端的重连策略 |

实例 hash 是规范根目录 SHA-256 的前 12 个十六进制字符。显式 `dataDir` 可在安装位置移动时保持状态稳定。Cordis 配置 HMR 会替换整行；不会监视 Agent Plugin 目录内部的文件系统编辑。

## 校验与发现

本包内置不可变的 Agent Plugins 1.0.0 JSON schema，并在 [`schemas/standards-lock.json`](schemas/standards-lock.json) 中记录其 SHA-256 hash 和 Agent Skills 源 revision。运行时激活绝不获取标准文件。

无效或不受支持的 `plugin.json` 会使该行失败。未知 manifest 字段和非对象 `extensions` 会被报告并忽略；已识别 extension namespace 的内容会保留但不校验，目前不实现任何 extension namespace。缺少 `skills` 目录或 `mcp.json` 是有效状态。固定组件路径类型错误或解析后位于规范根目录之外时，只禁用该组件类型。各个无效 skill 和 MCP 条目会被报告并跳过。每次包含性检查都会解析符号链接。

Skill 发现只读取直接的 `skills/*/SKILL.md` 条目。它会强制标准 frontmatter 字段、长度、名称语法，以及 skill 名称与目录名称相等。定义在激活时只解析一次。提供方名称为 `agent-plugin:<manifest-name>:<instance-hash>`，source 为 `agent-plugin`，rank 为 `600`，保留原 skill 名称，并将 `resourceBase` 设为 skill 目录。可选标准字段保存在 `metadata['agentskills.io']` 下；`allowed-tools` 只作为元数据，不授予批准或沙箱豁免。

## MCP 转换与信任

支持 `stdio` 和 `streamable-http` 条目；旧版 `sse` 条目会被报告并跳过。每个有效条目拥有独立释放的 Cordis 子 fiber；一个 sibling 失败不会拒绝整行，也不会移除正常工作的 sibling。

对于 stdio，`./` 命令在规范插件根目录内解析，裸命令则在应用插件环境值前依据 DSH 已清理的基础 `PATH` 解析。只有 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}` 会在参数、环境值和 `cwd` 中展开一次。保留变量按平台大小写语义检查，并在最后注入。显式工作目录必须解析到插件根目录或数据目录之下。启动前 `PLUGIN_DATA` 已存在。

对于 Streamable HTTP，endpoint 必须是绝对 HTTP(S) URL，不得包含凭据或 fragment，并且除 loopback 外必须使用 HTTPS。Header 名称必须有效，并且忽略大小写后唯一。值保持字面形式：适配器不执行 placeholder、secret 或 OAuth 展开。官方 MCP 客户端只在请求仍位于配置 origin 时附加所配置 header；跨 origin 重定向不会收到这些 header。

启用配置行是一项信任决策。Skills 会影响模型指令，stdio 服务器会在模型工具沙箱之外，以已清理环境执行受信任的宿主代码。

## 可移植 API 与证据

`@deepseek-ai/dsh-agent-plugins/portable` 在不导入 Cordis 的情况下提供发现和转换。宿主提供默认数据根目录、可执行文件搜索路径、平台语义，以及可选诊断回调或可执行文件解析器。离线 fixture 覆盖 schema 选择、校验例外、符号链接包含性、变量展开、环境和 URL 规则、故障隔离、生命周期、持久化及 namespace 派生。无密钥装配回放会加载一个 fixture skill，并调用确定性的 Node stdio MCP 工具。设置 `DSH_AGENT_PLUGINS_CORPUS=1` 可启用 lock-file corpus runner；它把固定版本仓库获取到临时目录，并在不启动外部命令或联系其服务的情况下校验发现结果。

## 模型体验

### 导入的 skills

#### 模型看到的内容

现有 skill 目录和 loader 以未修改的名称与描述公开每个已接受 skill，并在选择时返回其已解析正文和资源。沿用正常 DSH 提供方优先级：较低 rank 优先，其次按提供方注册顺序。

#### Token 影响

存在 skill 目录时，目录名称和描述会消耗请求 token。被选择的 skill 通过现有 skill 加载路径添加正文；未选择的正文不会进入上下文。

#### KV Cache 影响

只要已接受的 skill 集合、描述和已选择正文不变，就保持稳定。HMR 替换或不同插件根目录可能从首个受影响的目录或 skill token 起改变前缀。

### 导入的 MCP 工具

#### 模型看到的内容

每个已连接服务器贡献官方 MCP 客户端的服务器限定工具与结果。适配器只改变稳定的服务器 namespace 和连接配置；渲染与会话行为仍由 `dsh-mcp-client` 持有。

#### Token 影响

每个已注册工具 schema 都消耗请求 token；调用会按官方 MCP 客户端规则保留参数和渲染结果。

#### KV Cache 影响

只要已转换服务器标识与已发现工具 schema 不变，就保持稳定。服务器发现结果变化会替换受影响的定义。

## 已知限制与暂缓事项

- 只实现 Agent Skills、stdio MCP 和 Streamable HTTP MCP。Agent Plugin extension namespace 和旧版 HTTP+SSE 没有运行时适配器。
- 没有 downloader、updater、marketplace、Claude cache 发现、目录 watcher、Web UI 或 MCP 状态集成。
- Claude 专用 manifest、command、hook 和 agent 不属于此兼容目标。
- 在离线一致性、装配 snapshot、打包 consumer 检查和固定真实插件 corpus 一起通过前，本包保持私有且位于树内。独立提取是另行授权的变更，并会增加发布 bundle、默认禁用的模板行、已发布版本矩阵和社区目录元数据。
