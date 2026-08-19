# Compatibility packages

English | [中文](README.zh.md)

Compatibility packages translate external agent formats into existing DSH services without making those formats part of the product API spine.

| Package | Role | Runtime contributions |
|---|---|---|
| [`agent-plugins/`](agent-plugins/README.md) | Private incubation adapter for Agent Plugins 1.0 directories | `ctx.skills` provider and official `dsh-mcp-client` child fibers |

Compatibility packages remain opt-in. A package must define its supported standard version, validation and isolation rules, trust implications, and extraction criteria in its own README.
