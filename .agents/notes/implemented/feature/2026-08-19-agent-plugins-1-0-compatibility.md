# Agent Note: Agent Plugins 1.0 compatibility incubates as a private Cordis plugin

Status: implemented

English | [中文](2026-08-19-agent-plugins-1-0-compatibility.zh.md)

## Problem

Agent Plugins provide a vendor-neutral package format for skills and MCP servers, while DSH runtime composition is built from Cordis plugins and existing service registries. Loading Agent Plugin directories directly in the CLI would couple an external filesystem format to product startup, duplicate skill and MCP implementations, and introduce host-code execution before validation, isolation, and distribution behavior had conformance evidence.

The compatibility target also has two different lifecycle concerns. Format discovery and translation can remain portable across hosts, while DSH registration and teardown must obey Cordis effect ownership. A single adapter that entangles those concerns would be difficult to extract into a community-installable plugin without redesign.

## Decision

`@deepseek-ai/dsh-agent-plugins` is a private package under [`packages/compat/agent-plugins`](../../../../packages/compat/agent-plugins/README.md). One Cordis row owns one canonical Agent Plugin root, one in-memory skill provider, and one official `dsh-mcp-client` child fiber per valid MCP server. The package has no `dsh.bundle` manifest and is absent from the CLI, shipped profiles, and plugin installer. Tests and explicit development overlays are its only compositions.

The portable loader owns versioned schemas, manifest exceptions, Agent Skills parsing, canonical paths, stable identities, stdio environment translation, HTTP policy, and entry-level diagnostics. It has no Cordis import. The adapter supplies DSH home and scrubbed environment inputs, registers the parsed skill provider, and translates supported MCP records into child fibers. Cordis disposal owns every registration and child, and configuration HMR replaces the complete row rather than watching the plugin directory.

Agent Plugins 1.0.0 schemas are vendored with recorded hashes, and Agent Skills validation is pinned to a source revision. Runtime code never fetches standards. The manifest fails as a unit, absent component locations are valid, wrong-kind or escaping fixed locations disable their component, and malformed skill or MCP entries fail independently. Containment follows filesystem resolution and symlinks.

Skills keep their standard names, use provider rank `600`, and retain optional standard fields as namespaced metadata. `allowed-tools` carries information but grants no DSH permission. MCP support is limited to stdio and Streamable HTTP. Every server receives a stable bounded namespace derived from the plugin identity and raw server key, while tool behavior remains owned by the official MCP client.

Stdio translation resolves local commands within the canonical root, resolves bare executables against a scrubbed base `PATH`, expands only the two standard plugin variables once, protects reserved environment keys with platform case semantics, and constrains explicit working directories to the plugin root or persistent data directory. Streamable HTTP accepts secure absolute endpoints, with HTTP limited to loopback, and performs no secret or placeholder expansion. The official client strips every configured header when a redirect leaves the configured origin.

## Verification

Per-file unit coverage fixes the loader's manifest exceptions, skill rules, path and symlink cases, placeholder and environment semantics, URL and header rules, namespace derivation, and entry isolation. Cordis integration exercises provider precedence, child ownership, sibling survival, reconnect, persistent data, HMR replacement, and complete disposal. MCP-client regression coverage distinguishes same-origin redirects from cross-origin redirects.

A keyless assembled example loads a fixture skill and invokes a deterministic cross-platform Node stdio MCP tool through a real Loader process. Built-package and Loader checks protect exported entrypoints and vendored schemas. The opt-in corpus lock records repository, commit, plugin root, license, and expected components for representative skill-only, bundled-resource, stdio-variable, and Streamable HTTP plugins; it validates discovery without running third-party commands or contacting remote services.

## Alternatives considered

**Add the adapter directly to the CLI and base profiles.** Rejected because installation and discovery policy would become a product contract before conformance and trust behavior has independent distribution evidence.

**Depend on `dsh-skillport`.** Rejected because it is useful implementation evidence but accepts DSH-specific extensions and does not own strict Agent Plugins manifest and MCP semantics.

**Implement an MCP client inside the adapter.** Rejected because duplicate transports would split reconnection, tool projection, security hardening, and lifecycle behavior. Child Cordis fibers preserve one official implementation and isolate sibling failures.

**Implement Claude Code marketplace compatibility.** Rejected because Claude-specific manifests, commands, hooks, agents, cache layout, and marketplace installation are outside Agent Plugins 1.0 and would make the target ambiguous.

**Ship a downloader or automatic plugin discovery.** Rejected because selection and enablement are the trust decision. The incubation package accepts an explicit absolute root and does not widen host execution authority through implicit discovery.

## Consequences

DSH can validate and run the Agent Skills and supported MCP portions of an Agent Plugins 1.0 directory without adopting Claude-specific behavior or a second skill/MCP runtime. Invalid siblings are isolated, persistent state has an explicit identity rule, and HTTP authentication material does not cross origins through redirects.

The package is intentionally unavailable to ordinary installed profiles. Enabling an explicit development row trusts skill instructions and stdio host code; the scrubbed environment does not place that code inside the model tool sandbox. Legacy SSE, extension namespaces, status UI, marketplaces, downloading, updates, and directory watching remain absent.

The portable loader and Cordis adapter are arranged for a later subtree move without interface redesign. Standalone distribution remains a separate authorized change: its repository owns registry peer ranges, build and packed-install verification, a disabled bundle template, supported-release testing, release artifacts, and community catalog admission.
