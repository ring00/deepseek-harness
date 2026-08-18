# @deepseek-ai/dsh-client-ui-markdown-images

[English](README.md) | 中文

会话级 Markdown 图片策略插件。其浏览器半侧向每个投影会话贡献普通的 `MarkdownImageResolver`；可信宿主 RPC 应用纯 URL 检查，并通过已挂载的文件系统与附件服务导入本地文件。默认 Web bundle 同时挂载两侧，因此普通 Markdown 图片自动加载，而可疑远程目标需要用户操作。

## 远程 URL 策略

`inspectRemoteImageUrl(source)` 是纯函数：它只读取创作源字符串，不执行 I/O、会话查询、浏览器状态访问或重写。不含嵌入凭据、且未识别出 secret 的公共 HTTP(S) URL 会按原样自动加载。宿主使用 `@sanity-labs/secret-scan` 检查去除 fragment 后的请求 URL，并对路径与查询字段进行一次百分号解码检查；返回的 URL 仍保留 fragment，因为浏览器不会发送它。

识别出的 secret、本地名称或字面私有网络目标会显示可聚焦的占位按钮，且不会先设置 `<img src>`。悬停与键盘聚焦会披露本地化的策略原因，同一文本也会作为按钮的无障碍描述。按钮显示 Markdown alt 文本；alt 文本为空时则显示通用确认标签，绝不会用创作源字符串替代可见文案。激活后仅在当前挂载期间直接加载原始源字符串。`trustedOrigins` 可让精确的私有 origin 自动加载，但绝不会绕过 secret 检测。不支持的 scheme 与嵌入凭据仍是不可交互的失败。策略不会解析公共 DNS 名称，也不会特殊处理公共同源 URL。已加载图片仍由浏览器发出普通请求，并使用延迟加载、异步解码及 `referrerPolicy="no-referrer"`。

## 本地附件导入

相对路径从不可变的会话工作目录解析；同时支持绝对 POSIX 和 Windows 路径以及有效的本地 `file:` URL。读取经 `ctx.fs` 进行，因此读取权限由已挂载的 provider 决定。PNG、JPEG、WebP 与 GIF 字节经 `ctx.attachments` 准入；其字节、像素、聚合与媒体限制仍是权威规则。

首次成功显示时，插件在 `<DSH_HOME>/markdown-images/v1/mappings` 下存储一个附件引用。文件名是会话 ID、稳定渲染持有方及创作源字符串的 SHA-256 摘要；私有原子 JSON 记录只含附件引用。即使源文件后来变化或消失，历史回放仍读取该不可变附件。损坏的映射或缺失的附件会保持为可见失败，绝不会捕获替代源字节。

## 配置

`trustedOrigins` 默认为空列表。每个条目必须是精确的 HTTP(S) origin；带路径、查询、fragment 或嵌入凭据的条目会使插件加载失败。

```yaml
- id: ui-markdown-images
  config:
    trustedOrigins:
      - http://127.0.0.1:8080
      - https://images.example.com
```

## 模型体验

无。该插件改变浏览器图片呈现，但不会添加或修改模型请求。

#### KV Cache 影响

无；URL 检查与图片呈现不会改变模型请求。

## 已知限制与暂缓事项

- **Secret 检测是概率性的** — 扫描器识别提供方格式与部分熵模式，而不能识别任意机密文本。hostname、路径或查询中的未识别值会自动加载。远程 origin 也会收到浏览器的普通网络请求，以及浏览器策略为该 origin 发送的任何凭据。
- **误报需要点击** — 被识别的模式可能并无风险；确认只在当前挂载期间有效，重新加载或回放后会再次出现。
- **DNS 与重定向仍由浏览器负责** — 策略要求确认字面私有目标与本地名称，但不会解析公共名称或协调重定向。`trustedOrigins` 是精确例外，不是网络沙箱。
- **远程图片不持久化** — 历史回放会再次发起浏览器请求；只有本地源会成为持久附件。
- **配置仅限文件** — v1 通过 `cordis.yml` 暴露 `trustedOrigins`，没有 Settings UI。
- **本地格式刻意保持有限** — SVG 与非图片文件仍受阻；本插件不会扩大 AttachmentStore 限制。
