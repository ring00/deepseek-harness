import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as agentPlugins from '@deepseek-ai/dsh-agent-plugins'

describe('dsh-agent-plugins real Loader export path', () => {
  it('keeps the namespace plugin exports through Loader unwrapping', () => {
    expect('default' in agentPlugins).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(agentPlugins) as Record<string, unknown>
    expect(unwrapped).toBe(agentPlugins)
    expect(unwrapped.name).toBe('agent-plugins')
    expect(unwrapped.inject).toEqual(['agents', 'skills', 'tools', 'commands', 'credentials', 'settings'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
