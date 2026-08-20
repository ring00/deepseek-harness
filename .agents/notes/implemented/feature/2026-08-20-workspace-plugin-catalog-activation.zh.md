# Agent Note: 工作区插件目录将发现与激活分离

Status: implemented

[English](2026-08-20-workspace-plugin-catalog-activation.md) | 中文

## 问题

兼容服务原先把另一个客户端的激活元数据当作 DSH 策略，并从清单中省略所有被禁用安装。这会让 Agent 插件视图不完整，也没有 DSH 自己的方式阻止已发现插件贡献模型指令或通过 stdio MCP 执行宿主代码。它还会使 Claude cache 索引看起来像产品插件目录，尽管该索引的适当职责只是选择一个已安装版本。

发现与激活具有不同生命周期。发现取决于所选 agent（智能体）的规范工作区，并在 agent 创建期间为文件系统状态建立快照。激活是该工作区的持久用户选择。更改后者不能原地修改前者已发布的 skill（技能）、command 与 MCP 子项。

## 决策

内置目录依次包含已配置来源；项目 `.dsh/plugins`、`.agents/plugins` 与 `.claude/plugins`；然后是 `$DSH_HOME/plugins`、`~/.agents/plugins` 与 Claude 已安装索引。每个候选项仍必须包含 `plugin.json` 或 `.claude-plugin/plugin.json`。无论 Claude 启用状态如何，该索引都只为每个插件贡献最新且符合条件的用户安装或匹配项目的安装。它是版本选择器，绝不是 DSH 激活依据；未被索引引用的 cache 版本仍不可见。

所有发现的插件默认启用。兼容 Cordis 插件会注册必需的 `agent-plugins` settings（设置）namespace，并标记 `applies: restart`。其值是从工作区键到已禁用限定 ID 的映射。工作区键是规范最近 Git 根目录 SHA-256 摘要的前 12 个十六进制字符；没有 cwd 的 agent 使用稳定的 `user` bucket。限定 ID 已经不含路径，并把来源标识绑定到所选插件。

`agentPlugin.setEnabled(agent, qualifiedId, enabled)` 只接受该活跃 agent 已发现目录中的 ID。写入会串行执行并去除重复 ID；过时 ID 会无害地保留，直到后续写入触及其 bucket。只读 settings 提供方会拒绝修改。该方法返回更新后的快照，其 `enabled` 字段会立即显示期望状态。

活跃 generation 保持不可变。禁用已加载插件不会释放其注册项，启用已禁用插件也不会解析或挂载它。新建或恢复的 agent 会在 setup 时读取最新设置。因此，`enabled` 表示下一 generation 的期望状态，`status` 表示当前 generation 状态；两者不一致就是显式等待转换。

禁用候选项只进行 manifest 标识检查，以获得名称、版本和格式。检查不会创建插件数据、解析 skill 或 command、解析凭据或可执行文件，也不会转换 MCP。禁用条目报告 `disabled` 并省略组件计数。启用候选项保留 `loaded`、`partial` 或 `failed` 以及现有的组件隔离行为。

浏览器视图会列出完整的已发现目录，并为每个条目渲染无障碍开关。写入期间或 settings 只读时会禁用开关；修改成功时采用返回的快照，失败时保留原快照。刷新只重新获取当前 generation，绝不重新扫描文件系统。

## 验证

发现 fixture（测试前置数据）覆盖项目与用户 `.agents` 来源、顺序、home 覆盖、规范包含性、无视 Claude 启用状态的索引插件、最新版本选择以及未被索引 cache 的排除。适配器覆盖证明 manifest 检查会忽略格式错误的组件文件。Settings 集成覆盖默认激活、工作区隔离、活跃 generation 等待状态、后续 agent 采用、只读拒绝与 dispose（资源释放）。Loader snapshot（快照）通过项目 `.agents/plugins` 发现兼容 Claude fixture，并执行其 skill、command 与本地 stdio MCP 服务器。浏览器覆盖固定 disabled、等待启用、等待禁用、只读、保存中、写入成功与写入失败状态。

## 考虑过的替代方案

**保留 Claude 激活作为默认值。** 不予采用，因为另一个客户端编辑设置时，DSH 行为会静默变化，而且 Claude 之外发现的插件仍需要统一激活模型。

**使用一个全局禁用列表。** 不予采用，因为同一个限定来源可能在一个工作区受信任，而在另一个工作区被拒绝。Agent 最近 Git 根目录已经定义发现，因此其摘要可以定义对应 settings bucket 而不暴露路径。

**通过重新挂载活跃 generation 应用开关。** 不予采用，因为 skill、command 与 MCP 注册会成为存在重连和回滚竞争的部分可变事务。Agent setup 是现有的原子发布点。

**完整解析禁用插件以获得准确计数。** 不予采用，因为解析可能创建数据、解析 secret 与可执行文件，并准备宿主代码传输。除 manifest 标识外，禁用插件必须保持惰性。

## 后果

Agent 插件 tab（标签页）现在会分别回答两个问题：DSH 为该工作区发现了哪些兼容插件，以及下一 agent generation 应激活哪些插件。Claude 中被禁用的安装仍可见，并在 DSH 中默认启用，因此受支持安装来源中存在插件再加上 DSH 开关，构成显式信任模型。

Settings 文档可能保留已删除插件的 ID，而开关不会改变当前运行的 agent。两者都是有意设计：陈旧 ID 不产生影响，不可变 generation 则保持 setup、dispose 与模型可见注册项一致。全局策略、实时重新挂载、文件系统监视、安装器、Codex 与 OpenCode 仍是单独决策。
