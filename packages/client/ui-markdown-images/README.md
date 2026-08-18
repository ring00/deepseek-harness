# @deepseek-ai/dsh-client-ui-markdown-images

English | [中文](README.zh.md)

The session-scoped Markdown image policy plugin. Its browser half contributes a plain `MarkdownImageResolver` to each projected session; its trusted Host RPC applies pure URL inspection and imports local files through the mounted filesystem and attachment services. The default Web bundle mounts both halves, so ordinary Markdown images load automatically while suspicious remote destinations require a user gesture.

## Remote URL policy

`inspectRemoteImageUrl(source)` is a pure function: it reads only the authored source and performs no I/O, session lookup, browser-state access, or rewriting. Credential-free public HTTP(S) URLs without a recognized secret load automatically and exactly as authored. The Host scans the fragment-free request URL plus one percent-decoding pass over its path and query fields with `@sanity-labs/secret-scan`; fragments remain in the returned URL because browsers do not transmit them.

A recognized secret, local name, or literal private-network destination renders a focusable placeholder button without assigning an `<img src>`. Hover and keyboard focus expose localized details about the policy reason, and the same text is attached as the button's accessible description. The button shows Markdown alt text or a generic confirmation label when alt text is empty; it never substitutes the authored URL as visible copy. Activation loads the original source directly for that mounted rendering only. `trustedOrigins` lets an exact private origin load automatically but never bypasses secret detection. Unsupported schemes and embedded credentials remain non-interactive failures. Public DNS names are not resolved, and public same-origin URLs receive no special treatment. Loaded images remain ordinary browser requests with lazy loading, asynchronous decoding, and `referrerPolicy="no-referrer"`.

## Local attachment imports

Relative paths resolve from the immutable session working directory; absolute POSIX and Windows paths and valid local `file:` URLs are also accepted. Reads use `ctx.fs`, so the mounted provider owns read authority. PNG, JPEG, WebP, and GIF bytes are admitted through `ctx.attachments`; its byte, pixel, aggregate, and media limits remain authoritative.

The first successful display stores an attachment reference under `<DSH_HOME>/markdown-images/v1/mappings`. The filename is a SHA-256 digest of the session ID, stable rendering owner, and authored source; the private atomic JSON record contains only the attachment reference. Later replay reads that immutable attachment even if the source changes or disappears. A corrupt mapping or missing attachment remains a visible failure and never captures replacement source bytes.

## Configuration

`trustedOrigins` defaults to an empty list. Each entry must be an exact HTTP(S) origin; paths, queries, fragments, and embedded credentials are rejected when the plugin loads.

```yaml
- id: ui-markdown-images
  config:
    trustedOrigins:
      - http://127.0.0.1:8080
      - https://images.example.com
```

## Model Experience

None, as the plugin changes browser image presentation without adding to or modifying model requests.

#### KV Cache effect

None; URL inspection and image presentation do not alter model requests.

## Known Limitations and Deferred Work

- **Secret detection is probabilistic** — the scanner recognizes provider formats and selected entropy patterns, not arbitrary confidential text. An unrecognized value in a hostname, path, or query loads automatically. Remote origins also receive the browser's ordinary network request and any credentials its browser policy sends for that origin.
- **False positives require a click** — a recognized pattern may be harmless; confirmation is scoped to the mounted rendering and returns after reload or replay.
- **DNS and redirects remain browser-owned** — the policy confirms literal private destinations and local names but does not resolve public names or mediate redirects. `trustedOrigins` is an exact exception, not a network sandbox.
- **Remote images are not persisted** — history replay repeats the browser request; only local sources become durable attachments.
- **Configuration is file-only** — v1 exposes `trustedOrigins` through `cordis.yml` and has no Settings UI.
- **Local formats are deliberately narrow** — SVG and non-image files remain blocked; AttachmentStore limits are not expanded by this plugin.
