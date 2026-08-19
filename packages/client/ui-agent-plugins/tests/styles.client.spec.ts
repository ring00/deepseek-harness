import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(fileURLToPath(new URL('../src/client/AgentPluginsView.module.css', import.meta.url)), 'utf8')
const theme = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

describe('AgentPluginsView theme styles', () => {
  it('uses declared theme tokens for every foreground and surface', () => {
    const named = [...styles.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1])
    expect([...new Set(named)].filter(name => !theme.includes(`  ${String(name)}:`))).toEqual([])
    expect(styles).not.toContain('--dsh-')
  })
})
