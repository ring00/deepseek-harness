# Agent Note: Session-scoped Markdown image policy

Status: implemented

English | [中文](2026-08-18-markdown-image-policy-plugin.zh.md)

## Problem

Automatic Markdown images are useful, but an assistant can be induced to place model-visible secrets in an image URL. Assigning that URL to `<img src>` makes the browser disclose it without going through Tool permissions. Blocking all images or requiring a click for every image removes the expected Markdown experience, while blocking local paths prevents ordinary agent-generated artifacts from appearing in the conversation.

## Decision

`@deepseek-ai/dsh-client-ui-markdown-images` is a Host/Client plugin mounted by the default Web bundle. Its browser half contributes one resolver per projected session through the session-standard prop registry. `MarkdownText` receives that resolver as a plain prop together with a stable rendering owner used only for local attachment identity.

`inspectRemoteImageUrl(source)` is pure and reads only the authored source. It performs no I/O, session-log lookup, browser-state access, or URL rewriting. Credential-free public HTTP(S) URLs without a recognized secret load automatically and exactly as authored. The Host scans the fragment-free request URL and one percent-decoding pass over its path and query fields with pinned `@sanity-labs/secret-scan`; every high- or medium-confidence match requires confirmation. Unsupported schemes and embedded credentials remain blocked.

Local names and literal private-network HTTP(S) destinations also require confirmation. An exact `trustedOrigins` entry permits its private origin to load automatically but never bypasses secret detection. Public DNS names are not resolved, public same-origin URLs receive no special treatment, and an allowed remote URL remains a direct browser request with lazy loading, asynchronous decoding, and no referrer.

A confirmation result renders an image-shaped button without assigning an `<img src>`. Hover and keyboard focus disclose the localized policy reason, which is also the button's assistive description. Empty alt text uses a generic label instead of exposing the authored URL. Activation assigns the original source directly; it performs no second Host request and creates no durable authorization. Approval belongs to that mounted owner and source, so replacement, unmounting, reload, or replay restores the placeholder.

Relative paths resolve from the session working directory; absolute POSIX and Windows paths and valid local `file:` URLs are read through `ctx.fs`. PNG, JPEG, WebP, and GIF bytes are saved through `ctx.attachments`, whose validation and limits remain authoritative. The mapping key hashes session ID, stable rendering owner, and authored source. A private atomic record under `<DSH_HOME>/markdown-images/v1/mappings` contains only the attachment reference. Replay reads the original attachment, and a missing or corrupt attachment blocks instead of capturing changed source bytes. Concurrent requests for one key share the same import.

## Accepted residual risk

Secret scanning is probabilistic. Provider patterns and selected entropy rules do not recognize arbitrary confidential text, so an unrecognized value in a public hostname, path, or query loads automatically. Public DNS can resolve to a private address after inspection, redirects remain browser-owned, and a remote origin receives the browser's ordinary request plus any credentials browser policy sends for that origin. A false positive requires a click, while a click explicitly accepts the complete original URL.

## Alternatives considered

**Render every image as alt text.** This closes automatic image traffic but removes network diagrams, screenshots, and local artifacts from the normal conversation experience.

**Require a click before every remote image.** This makes every routine display interactive. Confirmation is limited to recognized secrets and literal private destinations so ordinary Markdown behavior remains automatic.

**Authorize or rewrite URLs from conversation provenance.** Session history, rendering cutoffs, and query reconstruction add cross-event state while still missing secrets encoded in novel locations. URL-only inspection is deterministic and preserves signed or otherwise meaningful URLs.

**Fetch every image through the Host and persist it.** A complete proxy needs redirect, DNS rebinding, egress, authentication, decompression, media, and size policy. Remote requests stay in the browser, while local files use existing filesystem and attachment authority.

**Re-read a local source when its cached attachment is unavailable.** That would make historical conversation rendering depend on mutable filesystem state. A terminal visible failure preserves replay identity and exposes storage corruption.

## Consequences

Default Web conversations, trajectories, compaction cards, plan and question surfaces, and Tool/Web presentation share one URL-only remote policy and one durable local importer. Safe images load automatically, suspicious destinations expose an explicit one-rendering approval, and local images survive source deletion and historical reload. The plugin adds a trusted Host RPC and private mapping store but no session-format event, Settings UI, remote-image cache, SVG support, or AttachmentStore extension. Tests pin pure URL inspection, exact source preservation, confirmation lifetime, private-origin exceptions, local import identity, resolver cleanup, streaming stability, and assembled browser behavior.
