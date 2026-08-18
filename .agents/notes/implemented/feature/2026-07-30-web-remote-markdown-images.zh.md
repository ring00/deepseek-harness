# Agent Note: Web 中的远程 Markdown 图片

Status: implemented

[English](2026-07-30-web-remote-markdown-images.md) | 中文

## 问题

assistant Markdown 可以使用标准图片语法引用图表和截图，但把每张图片都替换为斜体 alt 文本会失去普通 Markdown 行为。渲染器也服务于默认 Web bundle 以外的组合，因此需要一个不依赖会话服务的可用回退。

## 决策

未提供 `MarkdownImageResolver` 时，`MarkdownText` 将绝对 HTTP(S) 图片目标渲染为延迟加载的响应式 `<img>` 元素，并采用异步解码与 `referrerPolicy="no-referrer"`。相对路径、绝对本地路径、`file:` URL 与不受支持的 scheme 继续使用 alt 文本回退。原始 HTML 保持禁用，因此 assistant 无法通过手写 `<img>` 绕过 Markdown 图片组件。

默认 Web 组合提供经过独立评审的[会话级 Markdown 图片策略](2026-08-18-markdown-image-policy-plugin.md)。存在解析器时，组件把每个源交给它，并渲染获准的远程 URL、导入的附件字节或确认占位图。已完成的历史消息、流式输出、被中断的部分输出与其他 `MarkdownText` 消费方共享同一解析器 prop 约定。

## 考虑过的替代方案

**将所有图片都保留为 alt 文本。** 这种方案维持最小的网络表面，但无法满足在行内查看网络托管视觉产物的产品需求。

**每个远程 URL 都要求点击。** 这会打断普通 Markdown 行为，并让日常显示操作依赖用户交互。默认 Web 策略只对疑似 secret 与字面私有目标要求确认。

**让原语直接依赖会话与附件。** 这会把 Cordis 和应用状态引入纯 React 包。普通解析器 prop 使原语保持可复用，并让策略保持可选。

**在回退中允许 `data:` 图片。** 大型 data URL 会将二进制内容以文本形式重复写入持久 transcript。仅允许 HTTP(S) 的回退覆盖独立用途，同时不扩大会话日志。

## 后果

独立 `MarkdownText` 消费方无需宿主依赖便能保留自动远程图片行为。默认 Web 应用不使用这条直接路径，而是通过策略插件协调远程 URL 与本地文件，并对可疑目标要求点击。省略该插件的组合会明确接受绝对 HTTP(S) 图片目标发起的浏览器直接请求。
