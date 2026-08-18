# Agent Note: Remote Web Markdown images

Status: implemented

English | [中文](2026-07-30-web-remote-markdown-images.zh.md)

## Problem

Assistant Markdown can name diagrams and screenshots with standard image syntax, but replacing every image with italic alt text loses ordinary Markdown behavior. The renderer also serves compositions outside the default Web bundle, so it needs a useful fallback that does not depend on session services.

## Decision

When no `MarkdownImageResolver` is supplied, `MarkdownText` renders absolute HTTP(S) image destinations as lazy, responsive `<img>` elements with asynchronous decoding and `referrerPolicy="no-referrer"`. Relative paths, absolute local paths, `file:` URLs, and unsupported schemes retain the alt-text fallback. Raw HTML stays disabled, so an assistant cannot bypass the Markdown image component with a hand-authored `<img>`.

The default Web composition supplies the separately reviewed [session-scoped Markdown image policy](2026-08-18-markdown-image-policy-plugin.md). When a resolver is supplied, the component delegates every source to it and renders the approved remote URL, imported attachment bytes, or a confirmation placeholder. Finalized history, streaming output, interrupted partials, and other `MarkdownText` consumers share the same resolver prop contract.

## Alternatives considered

**Keep all images as alt text.** This preserves the smallest network surface but defeats the product need to inspect network-hosted visual artifacts inline.

**Require a click before every remote URL.** This interrupts ordinary Markdown behavior and makes routine display depend on user interaction. The default Web policy limits confirmation to suspected secrets and literal private destinations.

**Make the primitive depend directly on sessions and attachments.** That would pull Cordis and application state into a pure React package. A plain resolver prop keeps the primitive reusable and makes the policy optional.

**Allow `data:` images in the fallback.** Large data URLs duplicate binary content into durable transcript text. The HTTP(S)-only fallback covers the standalone use without expanding session logs.

## Consequences

Standalone `MarkdownText` consumers retain automatic remote-image behavior without Host dependencies. The default Web application does not use that direct path: it mediates remote URLs and local files through its policy plugin and requires a click for suspicious destinations. A composition that omits the plugin explicitly accepts direct browser requests for absolute HTTP(S) image destinations.
