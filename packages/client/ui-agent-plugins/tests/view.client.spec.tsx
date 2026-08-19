// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentPluginSnapshot } from '@deepseek-ai/dsh-agent-plugins/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPluginsView, type AgentPluginsViewInjected, type AgentPluginsViewProps } from '../src/client/AgentPluginsView.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]
const snapshot: AgentPluginSnapshot = { entries: [
  {
    qualifiedId: 'one' as never, name: 'daisyui', version: '5.0.0', format: 'agent-plugins', source: 'Project DSH',
    status: 'loaded', skillCount: 1, commandCount: 0, mcpServerCount: 0,
  },
  {
    qualifiedId: 'two' as never, name: 'commit-commands', format: 'claude', source: 'Claude user',
    status: 'partial', skillCount: 0, commandCount: 3, mcpServerCount: 0, error: 'hooks are unsupported',
  },
] }

function props(active: boolean, list: () => Promise<AgentPluginSnapshot>): AgentPluginsViewProps {
  return { active: () => active, list, t } as unknown as AgentPluginsViewProps
}

function mount(active: boolean, list = vi.fn(() => Promise.resolve(snapshot))) {
  render(<AgentPluginsView {...props(active, list)} />)
  return list
}

describe('AgentPluginsView', () => {
  it('mounts its Remote namespace after the base client Remote is available', () => {
    expect(inject).toContain('remote')
    expect(inject).not.toContain('remote.agentPlugin')
  })

  it('registers the view inside the namespace scope and invokes its mounted Remote', async () => {
    const ctx = new Context()
    class RemoteService extends Service {
      constructor() { super(ctx, 'remote') }
      async $mount(): Promise<() => Promise<void>> {
        const dispose = ctx.provide('remote.agentPlugin', { list: () => Promise.resolve({ ok: true, value: snapshot }) })
        return async () => { dispose() }
      }
    }
    new RemoteService()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({ name: 'root', children: { 'conversation.view': { kind: 'list', scope: 'session' } } } as never, (() => null) as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', { binding: () => ({}) })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const registered = ctx.slots.entries('conversation.view')[0]
    const makeInjected = registered?.inject as unknown as ((sessionId: SessionId) => AgentPluginsViewInjected)
    await expect(makeInjected('session' as SessionId).list()).resolves.toEqual(snapshot)
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.view')).toHaveLength(0)
  })

  it('renders inactive, loading, and empty states', async () => {
    const inactive = render(<AgentPluginsView {...props(false, vi.fn())} />)
    expect(screen.getByText(en.inactive)).toBeDefined()
    inactive.unmount()
    let resolve!: (value: AgentPluginSnapshot) => void
    mount(true, vi.fn(() => new Promise((value) => { resolve = value })))
    expect(screen.getByText(en.loading)).toBeDefined()
    await act(async () => { resolve({ entries: [] }) })
    expect(screen.getByText(en.empty)).toBeDefined()
  })

  it('shows actual names, source/format/status, counts, and one error summary', async () => {
    mount(true)
    expect(await screen.findByText('daisyui')).toBeDefined()
    expect(screen.getByText('commit-commands')).toBeDefined()
    expect(screen.getByText('Claude user')).toBeDefined()
    expect(screen.getByText('3 commands', { exact: false })).toBeDefined()
    expect(screen.getByText('hooks are unsupported')).toBeDefined()
  })

  it('snapshots the actual plugin names while switching between agent workspaces', async () => {
    const first = vi.fn(() => Promise.resolve<AgentPluginSnapshot>({ entries: [snapshot.entries[0]!] }))
    const second = vi.fn(() => Promise.resolve<AgentPluginSnapshot>({ entries: [snapshot.entries[1]!] }))
    const view = render(<AgentPluginsView {...props(true, first)} />)
    expect(await screen.findByText('daisyui')).toBeDefined()
    expect(view.container.textContent).toMatchInlineSnapshot('"Agent PluginsRefreshdaisyuiProject DSHagent-pluginsLoaded1 skills · 0 commands · 0 MCP servers5.0.0"')

    view.rerender(<AgentPluginsView {...props(true, second)} />)
    expect(await screen.findByText('commit-commands')).toBeDefined()
    expect(view.container.textContent).toMatchInlineSnapshot('"Agent PluginsRefreshcommit-commandsClaude userclaudePartial0 skills · 3 commands · 0 MCP servershooks are unsupported"')
  })

  it('refreshes the snapshot without rescanning through another operation', async () => {
    const list = mount(true)
    await screen.findByText('daisyui')
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('shows a transport error and retries', async () => {
    const list = vi.fn<() => Promise<AgentPluginSnapshot>>()
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(snapshot)
    mount(true, list)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(await screen.findByText('daisyui')).toBeDefined()
  })
})
